'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Link from 'next/link'

interface Product {
  id: string
  product_name: string
  product_code: string
  unit_cost: number
}

interface Warehouse {
  id: string
  name: string
}

interface Transaction {
  id: string
  product_id: string
  warehouse_id: string
  type: string
  quantity: number
  channel: string | null
  note: string | null
  recorded_by: string | null
  created_at: string
  products: Product | null
  warehouses: Warehouse | null
}

export default function TransactionsPage() {
  const { profile } = useAuth()
  const [products, setProducts] = useState<Product[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  // 폼 데이터
  const [formData, setFormData] = useState({
    product_id: '',
    warehouse_id: '',        // 출고 창고 (from)
    to_warehouse_id: '',     // 입고 창고 (to) - 이동 시에만
    type: '입고',
    quantity: 0,
    channel: '',
    note: '',
    lot_number: ''           // 로트번호 (입고 시 필수, 형식: YYMMDD-NN)
  })

  // 로트번호 형식 검증 (YYMMDD-NN)
  function isValidLotNumber(lot: string): boolean {
    const regex = /^\d{6}-\d{2}$/
    if (!regex.test(lot)) return false

    // 날짜 유효성 검사
    const year = parseInt('20' + lot.substring(0, 2))
    const month = parseInt(lot.substring(2, 4))
    const day = parseInt(lot.substring(4, 6))

    if (month < 1 || month > 12) return false
    if (day < 1 || day > 31) return false

    return true
  }

  // 오늘 날짜로 로트번호 기본값 생성
  function generateDefaultLotNumber(): string {
    const today = new Date()
    const yy = today.getFullYear().toString().slice(-2)
    const mm = (today.getMonth() + 1).toString().padStart(2, '0')
    const dd = today.getDate().toString().padStart(2, '0')
    return `${yy}${mm}${dd}-01`
  }

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    setLoading(true)

    // 활성 제품만 가져오기
    const { data: productsData } = await supabase
      .from('products')
      .select('id, product_name, product_code, unit_cost')
      .eq('is_active', true)

    const { data: warehousesData } = await supabase
      .from('warehouses')
      .select('id, name')

    const { data: transactionsData } = await supabase
      .from('transactions')
      .select(`
        *,
        products (id, product_name, product_code),
        warehouses (id, name)
      `)
      .order('created_at', { ascending: false })
      .limit(50)

    setProducts(productsData || [])
    setWarehouses(warehousesData || [])
    setTransactions(transactionsData || [])
    setLoading(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!formData.product_id || !formData.warehouse_id || formData.quantity <= 0) {
      alert('제품, 창고, 수량을 확인해주세요.')
      return
    }

    // 입고 시 로트번호 필수
    if (formData.type === '입고') {
      if (!formData.lot_number) {
        alert('입고 시 로트번호를 입력해주세요.\n형식: YYMMDD-NN (예: 250128-01)')
        return
      }
      if (!isValidLotNumber(formData.lot_number)) {
        alert('로트번호 형식이 올바르지 않습니다.\n형식: YYMMDD-NN (예: 250128-01)')
        return
      }
    }

    // 이동인 경우 목적지 창고 필수
    if (formData.type === '이동' && !formData.to_warehouse_id) {
      alert('입고 창고(목적지)를 선택해주세요.')
      return
    }

    // 이동 처리
    if (formData.type === '이동') {
      const fromWarehouse = warehouses.find(w => w.id === formData.warehouse_id)
      const toWarehouse = warehouses.find(w => w.id === formData.to_warehouse_id)
      const noteText = formData.note || '창고 이동'

      // 1. 출고 트랜잭션 (from 창고)
      await supabase.from('transactions').insert([{
        product_id: formData.product_id,
        warehouse_id: formData.warehouse_id,
        type: '출고',
        quantity: formData.quantity,
        channel: null,
        note: `[이동] ${noteText} → ${toWarehouse?.name}`,
        recorded_by: profile?.name || null
      }])

      // 2. 입고 트랜잭션 (to 창고)
      await supabase.from('transactions').insert([{
        product_id: formData.product_id,
        warehouse_id: formData.to_warehouse_id,
        type: '입고',
        quantity: formData.quantity,
        channel: null,
        note: `[이동] ${noteText} ← ${fromWarehouse?.name}`,
        recorded_by: profile?.name || null
      }])

      // 3. from 창고 재고 감소
      const { data: fromInv } = await supabase
        .from('inventory')
        .select('id, quantity')
        .eq('product_id', formData.product_id)
        .eq('warehouse_id', formData.warehouse_id)
        .single()

      if (fromInv) {
        await supabase.from('inventory')
          .update({ quantity: fromInv.quantity - formData.quantity, updated_at: new Date().toISOString() })
          .eq('id', fromInv.id)
      }

      // 4. to 창고 재고 증가
      const { data: toInv } = await supabase
        .from('inventory')
        .select('id, quantity')
        .eq('product_id', formData.product_id)
        .eq('warehouse_id', formData.to_warehouse_id)
        .single()

      if (toInv) {
        await supabase.from('inventory')
          .update({ quantity: toInv.quantity + formData.quantity, updated_at: new Date().toISOString() })
          .eq('id', toInv.id)
      } else {
        await supabase.from('inventory').insert([{
          product_id: formData.product_id,
          warehouse_id: formData.to_warehouse_id,
          quantity: formData.quantity
        }])
      }

      alert(`이동 완료!\n${fromWarehouse?.name} → ${toWarehouse?.name}`)
    } else {
      // 일반 입고/출고 처리
      // 1. 입출고 기록 저장
      const { error: txError } = await supabase
        .from('transactions')
        .insert([{
          product_id: formData.product_id,
          warehouse_id: formData.warehouse_id,
          type: formData.type,
          quantity: formData.quantity,
          channel: formData.channel || null,
          note: formData.note || null,
          recorded_by: profile?.name || null
        }])

      if (txError) {
        alert('기록 실패: ' + txError.message)
        return
      }

      // 2. 재고 업데이트 (로트번호 기준 관리)
      if (formData.type === '입고') {
        // 입고: 제품+창고+로트번호로 로트 찾기
        const { data: existingInventory } = await supabase
          .from('inventory')
          .select('*')
          .eq('product_id', formData.product_id)
          .eq('warehouse_id', formData.warehouse_id)
          .eq('lot_number', formData.lot_number)
          .single()

        if (existingInventory) {
          await supabase
            .from('inventory')
            .update({
              quantity: existingInventory.quantity + formData.quantity,
              updated_at: new Date().toISOString()
            })
            .eq('id', existingInventory.id)
        } else {
          await supabase
            .from('inventory')
            .insert([{
              product_id: formData.product_id,
              warehouse_id: formData.warehouse_id,
              quantity: formData.quantity,
              lot_number: formData.lot_number
            }])
        }
      } else {
        // 출고: FIFO (로트번호 오름차순으로 가장 오래된 로트에서 차감)
        const { data: existingInventory } = await supabase
          .from('inventory')
          .select('*')
          .eq('product_id', formData.product_id)
          .eq('warehouse_id', formData.warehouse_id)
          .order('lot_number', { ascending: true })
          .limit(1)
          .single()

        if (existingInventory) {
          await supabase
            .from('inventory')
            .update({
              quantity: existingInventory.quantity - formData.quantity,
              updated_at: new Date().toISOString()
            })
            .eq('id', existingInventory.id)
        }
      }

      alert(`${formData.type} 완료!`)
    }

    setFormData({
      product_id: '',
      warehouse_id: '',
      to_warehouse_id: '',
      type: '입고',
      quantity: 0,
      channel: '',
      note: '',
      lot_number: ''
    })
    setShowForm(false)
    fetchData()
  }

  async function handleDelete(tx: Transaction) {
    const confirmMsg = `정말 삭제하시겠습니까?\n\n${tx.type}: ${tx.products?.product_name} ${tx.quantity.toLocaleString()}개\n\n삭제 시 재고가 자동으로 복원됩니다.`

    if (!confirm(confirmMsg)) return

    try {
      // 1. 재고 복원 (입고였으면 빼기, 출고였으면 더하기)
      const { data: inventory } = await supabase
        .from('inventory')
        .select('id, quantity')
        .eq('product_id', tx.product_id)
        .eq('warehouse_id', tx.warehouse_id)
        .single()

      if (inventory) {
        const restoredQty = tx.type === '입고'
          ? inventory.quantity - tx.quantity  // 입고 삭제 → 재고 감소
          : inventory.quantity + tx.quantity  // 출고 삭제 → 재고 증가

        await supabase
          .from('inventory')
          .update({ quantity: restoredQty, updated_at: new Date().toISOString() })
          .eq('id', inventory.id)
      }

      // 2. 트랜잭션 삭제
      await supabase
        .from('transactions')
        .delete()
        .eq('id', tx.id)

      alert('삭제 완료! 재고가 복원되었습니다.')
      fetchData()
    } catch (error) {
      console.error('삭제 오류:', error)
      alert('삭제 중 오류가 발생했습니다.')
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-xl">로딩 중...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        {/* 헤더 */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <Link href="/" className="text-blue-600 hover:underline mb-2 inline-block">
              ← 대시보드로
            </Link>
            <h1 className="text-3xl font-bold text-gray-900">입출고 관리</h1>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-green-600 text-white px-6 py-3 rounded-lg hover:bg-green-700 transition"
          >
            {showForm ? '취소' : '+ 입출고 등록'}
          </button>
        </div>

        {/* 입출고 등록 폼 */}
        {showForm && (
          <div className="bg-white rounded-lg shadow p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4">입출고 등록</h2>
            <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  유형 *
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="입고"
                      checked={formData.type === '입고'}
                      onChange={(e) => setFormData({...formData, type: e.target.value, to_warehouse_id: ''})}
                      className="mr-2"
                    />
                    <span className="text-green-600 font-medium">입고 (+)</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="출고"
                      checked={formData.type === '출고'}
                      onChange={(e) => setFormData({...formData, type: e.target.value, to_warehouse_id: ''})}
                      className="mr-2"
                    />
                    <span className="text-red-600 font-medium">출고 (-)</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="이동"
                      checked={formData.type === '이동'}
                      onChange={(e) => setFormData({...formData, type: e.target.value})}
                      className="mr-2"
                    />
                    <span className="text-blue-600 font-medium">이동 (→)</span>
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  수량 *
                </label>
                <input
                  type="number"
                  required
                  min="1"
                  placeholder="예: 500"
                  value={formData.quantity || ''}
                  onChange={(e) => setFormData({...formData, quantity: Number(e.target.value)})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  제품 *
                </label>
                <select
                  required
                  value={formData.product_id}
                  onChange={(e) => setFormData({...formData, product_id: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">제품 선택</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.product_name} ({product.product_code})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {formData.type === '이동' ? '출고 창고 (from) *' : '창고 *'}
                </label>
                <select
                  required
                  value={formData.warehouse_id}
                  onChange={(e) => setFormData({...formData, warehouse_id: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">{formData.type === '이동' ? '출고 창고 선택' : '창고 선택'}</option>
                  {warehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.name}
                    </option>
                  ))}
                </select>
              </div>
              {formData.type === '이동' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    입고 창고 (to) *
                  </label>
                  <select
                    required
                    value={formData.to_warehouse_id}
                    onChange={(e) => setFormData({...formData, to_warehouse_id: e.target.value})}
                    className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">입고 창고 선택</option>
                    {warehouses.filter(w => w.id !== formData.warehouse_id).map((warehouse) => (
                      <option key={warehouse.id} value={warehouse.id}>
                        {warehouse.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  채널 (출고 시)
                </label>
                <input
                  type="text"
                  placeholder="예: 올리브영, 홈쇼핑"
                  value={formData.channel}
                  onChange={(e) => setFormData({...formData, channel: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              {formData.type === '입고' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    로트번호 * <span className="text-gray-400 font-normal">(YYMMDD-NN)</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder={generateDefaultLotNumber()}
                    value={formData.lot_number}
                    onChange={(e) => setFormData({...formData, lot_number: e.target.value})}
                    className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-400 mt-1">예: 250128-01 (2025년 1월 28일, 첫 번째 생산)</p>
                </div>
              )}
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  메모
                </label>
                <input
                  type="text"
                  placeholder="예: 샘플 출고, 생산 완료"
                  value={formData.note}
                  onChange={(e) => setFormData({...formData, note: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div className="md:col-span-2">
                <button
                  type="submit"
                  className={`w-full py-3 rounded-lg transition font-medium text-white ${
                    formData.type === '입고'
                      ? 'bg-green-600 hover:bg-green-700'
                      : formData.type === '출고'
                      ? 'bg-red-600 hover:bg-red-700'
                      : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {formData.type === '입고' ? '입고 등록' : formData.type === '출고' ? '출고 등록' : '이동 등록'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* 입출고 기록 목록 */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-6 border-b">
            <h2 className="text-xl font-semibold">입출고 기록 ({transactions.length}건)</h2>
          </div>
          <div className="p-6">
            {transactions.length === 0 ? (
              <p className="text-gray-500 text-center py-8">
                입출고 기록이 없습니다.
              </p>
            ) : (
              <div className="space-y-4">
                {transactions.map((tx) => {
                  // 내부 이동인지 확인 (note에 [이동] 또는 [샘플(이동)] 포함)
                  const isTransfer = tx.note?.includes('[이동]') || tx.note?.includes('[샘플(이동)]')
                  const displayType = isTransfer ? '이동' : tx.type

                  return (
                  <div key={tx.id} className="flex items-center justify-between border-b pb-4">
                    <div className="flex items-center gap-4">
                      <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                        isTransfer
                          ? 'bg-blue-100 text-blue-800'
                          : tx.type === '입고'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {displayType}
                      </span>
                      <div>
                        <p className="font-medium">
                          {tx.products?.product_name || '(삭제된 제품)'}
                        </p>
                        <p className="text-sm text-gray-500">
                          {tx.warehouses?.name} {tx.channel && `→ ${tx.channel}`}
                        </p>
                        {tx.note && (
                          <p className="text-sm text-gray-400">메모: {tx.note}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className={`font-semibold text-lg ${
                          tx.type === '입고' ? 'text-green-600' : 'text-red-600'
                        }`}>
                          {tx.type === '입고' ? '+' : '-'}{tx.quantity.toLocaleString()}개
                        </p>
                        <p className="text-sm text-gray-500">
                          {new Date(tx.created_at).toLocaleDateString('ko-KR')}
                        </p>
                        {tx.recorded_by && (
                          <p className="text-sm text-gray-400">{tx.recorded_by}</p>
                        )}
                      </div>
                      <button
                        onClick={() => handleDelete(tx)}
                        className="text-gray-400 hover:text-red-600 p-2 rounded-lg hover:bg-red-50 transition"
                        title="삭제"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
