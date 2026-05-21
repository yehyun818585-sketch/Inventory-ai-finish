'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'

interface Product {
  id: string
  product_name: string
  product_code: string
  unit_cost: number
  shelf_life_months: number | null
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
  sub_type: string | null
  quantity: number
  resulting_quantity: number | null
  lot_number: string | null
  stock_type: string | null
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

  // 오늘 날짜 (YYYY-MM-DD 형식)
  const getTodayString = () => {
    const today = new Date()
    return today.toISOString().split('T')[0]
  }

  // 폼 데이터
  const [formData, setFormData] = useState({
    product_id: '',
    warehouse_id: '',        // 출고 창고 (from)
    to_warehouse_id: '',     // 입고 창고 (to) - 이동 시에만
    type: '입고',
    sub_type: '',            // 출고 사유: 판매/샘플/폐기 | 조정 시 없음
    quantity: 0,
    channel: '',
    note: '',
    lot_number: '',          // 로트번호 (입고 시 필수, 형식: YYMMDD-NN)
    transaction_date: '',    // 거래 날짜 (기본값: 오늘)
    stock_type: '일반',      // 재고 구분: 일반 / 기획용
    lot_unit_cost: ''        // 이번 입고 원가 (기획용일 때 직접 입력, 빈값이면 제품 기본원가)
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

    // 미래 날짜 차단
    const lotDate = new Date(year, month - 1, day)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (lotDate > today) return false

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

  // 특정 제품+창고의 현재 총 재고 조회 (resulting_quantity 계산용)
  async function getTotalInventory(product_id: string, warehouse_id: string): Promise<number> {
    const { data } = await supabase
      .from('inventory')
      .select('quantity')
      .eq('product_id', product_id)
      .eq('warehouse_id', warehouse_id)
      .gt('quantity', 0)
    return (data || []).reduce((sum, inv) => sum + inv.quantity, 0)
  }

  useEffect(() => {
    fetchData()

    const channel = supabase
      .channel('transactions-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => {
        fetchData()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, () => {
        fetchData()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  async function fetchData() {
    if (!profile?.company_id) return
    setLoading(true)
    const cid = profile.company_id

    // 활성 제품만 가져오기
    const { data: productsData } = await supabase
      .from('products')
      .select('id, product_name, product_code, unit_cost, shelf_life_months')
      .eq('company_id', cid)
      .eq('is_active', true)

    const { data: warehousesData } = await supabase
      .from('warehouses')
      .select('id, name')
      .eq('company_id', cid)

    const { data: transactionsData } = await supabase
      .from('transactions')
      .select(`
        *,
        products (id, product_name, product_code),
        warehouses (id, name)
      `)
      .eq('company_id', cid)
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
        alert('로트번호가 올바르지 않습니다.\n형식: YYMMDD-NN (예: 250128-01)\n미래 날짜는 입력할 수 없습니다.')
        return
      }
    }

    // 이동인 경우 목적지 창고 필수
    if (formData.type === '이동' && !formData.to_warehouse_id) {
      alert('입고 창고(목적지)를 선택해주세요.')
      return
    }

    // 출고인 경우 사유 필수
    if (formData.type === '출고' && !formData.sub_type) {
      alert('출고 사유를 선택해주세요. (판매 / 샘플 / 폐기)')
      return
    }

    // 날짜 처리: 선택한 날짜 또는 오늘
    const transactionDate = formData.transaction_date
      ? new Date(formData.transaction_date + 'T09:00:00').toISOString()
      : new Date().toISOString()

    // 이동 처리
    if (formData.type === '이동') {
      const fromWarehouse = warehouses.find(w => w.id === formData.warehouse_id)
      const toWarehouse = warehouses.find(w => w.id === formData.to_warehouse_id)

      // 이동 시 출발 창고 재고 부족 체크
      const { data: fromInvCheck } = await supabase
        .from('inventory')
        .select('quantity')
        .eq('product_id', formData.product_id)
        .eq('warehouse_id', formData.warehouse_id)
        .gt('quantity', 0)

      const fromTotal = (fromInvCheck || []).reduce((sum, inv) => sum + inv.quantity, 0)
      if (fromTotal < formData.quantity) {
        alert(`재고 부족!\n\n${fromWarehouse?.name} 가용 재고: ${fromTotal.toLocaleString()}개\n요청: ${formData.quantity.toLocaleString()}개`)
        return
      }

      // from 창고 재고 감소
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

      // to 창고 재고 증가
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
          quantity: formData.quantity,
          company_id: profile?.company_id
        }])
      }

      // resulting_quantity: 이동 후 from 창고 잔액
      const moveResultingQty = await getTotalInventory(formData.product_id, formData.warehouse_id)

      // 이동 트랜잭션 (단일 레코드)
      await supabase.from('transactions').insert([{
        product_id: formData.product_id,
        warehouse_id: formData.warehouse_id,
        type: '이동',
        sub_type: null,
        quantity: formData.quantity,
        resulting_quantity: moveResultingQty,
        channel: null,
        note: `${fromWarehouse?.name} → ${toWarehouse?.name}${formData.note ? ` (${formData.note})` : ''}`,
        recorded_by: profile?.name || null,
        created_at: transactionDate,
        company_id: profile?.company_id
      }])

      alert(`이동 완료!\n${fromWarehouse?.name} → ${toWarehouse?.name}`)
    } else if (formData.type === '조정') {
      // ── 조정 처리 ──
      const targetQty = formData.quantity
      const currentTotal = await getTotalInventory(formData.product_id, formData.warehouse_id)
      const delta = targetQty - currentTotal

      if (delta === 0) {
        alert('현재 재고와 목표 수량이 같습니다. 조정이 필요하지 않습니다.')
        return
      }

      if (delta > 0) {
        // 재고 증가: 기존 로트 중 마지막 것에 수량 추가 (없으면 미지정로트 생성)
        const { data: existingLots } = await supabase
          .from('inventory')
          .select('id, quantity, lot_number')
          .eq('product_id', formData.product_id)
          .eq('warehouse_id', formData.warehouse_id)
          .gt('quantity', 0)
          .order('lot_number', { ascending: false })
          .limit(1)

        if (existingLots && existingLots.length > 0) {
          // 가장 최근 로트에 수량 추가
          await supabase.from('inventory')
            .update({ quantity: existingLots[0].quantity + delta, updated_at: new Date().toISOString() })
            .eq('id', existingLots[0].id)
        } else {
          // 로트가 없는 경우에만 새 레코드 생성
          await supabase.from('inventory').insert([{
            product_id: formData.product_id,
            warehouse_id: formData.warehouse_id,
            quantity: delta,
            lot_number: null
          }])
        }
      } else {
        // 재고 감소: FIFO로 차감
        const { data: inventoryLots } = await supabase
          .from('inventory')
          .select('id, quantity, lot_number')
          .eq('product_id', formData.product_id)
          .eq('warehouse_id', formData.warehouse_id)
          .gt('quantity', 0)
          .order('lot_number', { ascending: true })

        let remaining = Math.abs(delta)
        for (const lot of inventoryLots || []) {
          if (remaining <= 0) break
          const deduct = Math.min(lot.quantity, remaining)
          const newQty = lot.quantity - deduct
          if (newQty <= 0) {
            await supabase.from('inventory').delete().eq('id', lot.id)
          } else {
            await supabase.from('inventory').update({ quantity: newQty, updated_at: new Date().toISOString() }).eq('id', lot.id)
          }
          remaining -= deduct
        }
      }

      const { error: adjError } = await supabase.from('transactions').insert([{
        product_id: formData.product_id,
        warehouse_id: formData.warehouse_id,
        type: '조정',
        sub_type: null,
        quantity: delta,
        resulting_quantity: targetQty,
        channel: null,
        note: `실사 조정: ${currentTotal.toLocaleString()} → ${targetQty.toLocaleString()}개${formData.note ? ` (${formData.note})` : ''}`,
        recorded_by: profile?.name || null,
        created_at: transactionDate,
        company_id: profile?.company_id
      }])
      if (adjError) { alert('기록 실패: ' + adjError.message); return }

      alert(`조정 완료!\n${currentTotal.toLocaleString()}개 → ${targetQty.toLocaleString()}개`)
    } else {
      // 일반 입고/출고 처리

      // 출고인 경우: 재고 부족 체크를 먼저 수행
      if (formData.type === '출고') {
        const { data: inventoryLots } = await supabase
          .from('inventory')
          .select('*')
          .eq('product_id', formData.product_id)
          .eq('warehouse_id', formData.warehouse_id)
          .gt('quantity', 0)
          .order('lot_number', { ascending: true })

        const totalAvailable = (inventoryLots || []).reduce((sum, lot) => sum + lot.quantity, 0)
        if (totalAvailable < formData.quantity) {
          alert(`재고 부족!\n\n요청: ${formData.quantity.toLocaleString()}개\n가용 재고: ${totalAvailable.toLocaleString()}개\n부족: ${(formData.quantity - totalAvailable).toLocaleString()}개`)
          return
        }
      }

      // 재고 업데이트 (로트번호 기준 관리)
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
              stock_type: formData.stock_type,
              lot_unit_cost: formData.lot_unit_cost !== '' ? Number(formData.lot_unit_cost) : existingInventory.lot_unit_cost,
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
              lot_number: formData.lot_number,
              stock_type: formData.stock_type,
              lot_unit_cost: formData.lot_unit_cost !== '' ? Number(formData.lot_unit_cost) : null,
              company_id: profile?.company_id
            }])
        }

        // 입고 기록 저장
        const inboundResultingQty = await getTotalInventory(formData.product_id, formData.warehouse_id)
        const { error: txError } = await supabase
          .from('transactions')
          .insert([{
            product_id: formData.product_id,
            warehouse_id: formData.warehouse_id,
            type: '입고',
            sub_type: null,
            quantity: formData.quantity,
            resulting_quantity: inboundResultingQty,
            lot_number: formData.lot_number || null,
            stock_type: formData.stock_type || '일반',
            channel: formData.channel || null,
            note: formData.note || null,
            recorded_by: profile?.name || null,
            created_at: transactionDate,
            company_id: profile?.company_id
          }])
        if (txError) { alert('기록 실패: ' + txError.message); return }
      } else {
        // 출고: 만료/임박 로트 제외, 정상 로트만 FIFO (로트번호 오름차순)
        const { data: inventoryLots } = await supabase
          .from('inventory')
          .select('id, quantity, lot_number')
          .eq('product_id', formData.product_id)
          .eq('warehouse_id', formData.warehouse_id)
          .gt('quantity', 0)

        // products 상태에서 직접 shelf_life_months 가져오기 (조인 불필요)
        const selectedProduct = products.find(p => p.id === formData.product_id)
        const shelfLifeMonths = selectedProduct?.shelf_life_months || 24
        console.log('[FIFO] selectedProduct:', selectedProduct)
        console.log('[FIFO] shelfLifeMonths:', shelfLifeMonths)
        console.log('[FIFO] inventoryLots:', inventoryLots)

        const today = new Date()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isExpiredOrWarning = (lot: any): boolean => {
          if (!lot.lot_number || !/^\d{6}-\d{2}$/.test(lot.lot_number)) return false
          const y = parseInt('20' + lot.lot_number.substring(0, 2))
          const m = parseInt(lot.lot_number.substring(2, 4)) - 1
          const d = parseInt(lot.lot_number.substring(4, 6))
          const expiry = new Date(y, m, d)
          expiry.setMonth(expiry.getMonth() + shelfLifeMonths)
          const days = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
          const result = days <= shelfLifeMonths * 30 * 0.25
          console.log(`[FIFO] lot: ${lot.lot_number}, days: ${days}, threshold: ${shelfLifeMonths * 30 * 0.25}, isExpiredOrWarning: ${result}`)
          return result
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eligible = (inventoryLots || [])
          .filter((lot: any) => !isExpiredOrWarning(lot))
          .sort((a: any, b: any) => {
            if (a.lot_number && b.lot_number) return a.lot_number.localeCompare(b.lot_number)
            return 0
          })
        console.log('[FIFO] eligible lots:', eligible)

        const eligibleTotal = eligible.reduce((sum: number, lot: any) => sum + lot.quantity, 0)
        if (eligibleTotal < formData.quantity) {
          alert(`출고 가능 재고 부족!\n\n만료/임박 로트 제외 후 가용 재고: ${eligibleTotal.toLocaleString()}개\n요청: ${formData.quantity.toLocaleString()}개\n\n(만료/임박 로트는 출고에서 제외됩니다)`)
          return
        }

        let remaining = formData.quantity
        const lotDeductions: string[] = []
        for (const lot of eligible) {
          if (remaining <= 0) break
          const deduct = Math.min(lot.quantity, remaining)
          const newQty = lot.quantity - deduct
          lotDeductions.push(`${lot.lot_number} ${deduct.toLocaleString()}개`)
          if (newQty <= 0) {
            await supabase.from('inventory').delete().eq('id', lot.id)
          } else {
            await supabase.from('inventory').update({ quantity: newQty, updated_at: new Date().toISOString() }).eq('id', lot.id)
          }
          remaining -= deduct
        }

        // 재고 차감 성공 후 출고 기록 저장 (로트 정보 포함)
        const outboundResultingQty = await getTotalInventory(formData.product_id, formData.warehouse_id)
        const lotNote = `[로트] ${lotDeductions.join(' / ')}`
        const finalNote = formData.note ? `${formData.note} | ${lotNote}` : lotNote
        const { error: txError } = await supabase
          .from('transactions')
          .insert([{
            product_id: formData.product_id,
            warehouse_id: formData.warehouse_id,
            type: '출고',
            sub_type: formData.sub_type || null,
            quantity: formData.quantity,
            resulting_quantity: outboundResultingQty,
            channel: formData.channel || null,
            note: finalNote,
            recorded_by: profile?.name || null,
            created_at: transactionDate,
            company_id: profile?.company_id
          }])
        if (txError) { alert('기록 실패: ' + txError.message); return }
      }

      alert(`${formData.type} 완료!`)
    }

    setFormData({
      product_id: '',
      warehouse_id: '',
      to_warehouse_id: '',
      type: '입고',
      sub_type: '',
      quantity: 0,
      channel: '',
      note: '',
      lot_number: '',
      transaction_date: '',
      stock_type: '일반',
      lot_unit_cost: ''
    })
    setShowForm(false)
    fetchData()
  }

  async function handleDelete(tx: Transaction) {
    const confirmMsg = `정말 삭제하시겠습니까?\n\n${tx.type}: ${tx.products?.product_name} ${tx.quantity.toLocaleString()}개\n\n삭제 시 재고가 자동으로 복원됩니다.`

    if (!confirm(confirmMsg)) return

    try {
      if (tx.type === '이동') {
        // 이동 삭제: 양쪽 창고 재고 복원
        // note 형식: "출고창고 → 입고창고" 또는 "출고창고 → 입고창고 (메모)"
        const noteMatch = tx.note?.match(/^(.+?) → (.+?)(?:\s*\(|$)/)
        if (noteMatch) {
          const fromWarehouseName = noteMatch[1].trim()
          const toWarehouseName = noteMatch[2].trim()

          // from 창고 찾기 (출고한 창고 → 재고 복원)
          const fromWarehouse = warehouses.find(w => w.name === fromWarehouseName)
          // to 창고 찾기 (입고한 창고 → 재고 감소)
          const toWarehouse = warehouses.find(w => w.name === toWarehouseName)

          // from 창고 재고 복원 (+ quantity)
          if (fromWarehouse) {
            const { data: fromInv } = await supabase
              .from('inventory')
              .select('id, quantity')
              .eq('product_id', tx.product_id)
              .eq('warehouse_id', fromWarehouse.id)
              .single()

            if (fromInv) {
              await supabase
                .from('inventory')
                .update({ quantity: fromInv.quantity + tx.quantity, updated_at: new Date().toISOString() })
                .eq('id', fromInv.id)
            }
          }

          // to 창고 재고 감소 (- quantity)
          if (toWarehouse) {
            const { data: toInv } = await supabase
              .from('inventory')
              .select('id, quantity')
              .eq('product_id', tx.product_id)
              .eq('warehouse_id', toWarehouse.id)
              .single()

            if (toInv) {
              await supabase
                .from('inventory')
                .update({ quantity: toInv.quantity - tx.quantity, updated_at: new Date().toISOString() })
                .eq('id', toInv.id)
            }
          }
        }
      } else {
        if (tx.type === '입고') {
          // 입고 삭제: lot_number + stock_type으로 정확한 로트 찾아서 수량 감소
          let q = supabase.from('inventory').select('id, quantity')
            .eq('product_id', tx.product_id)
            .eq('warehouse_id', tx.warehouse_id)
          if (tx.lot_number) q = q.eq('lot_number', tx.lot_number)
          if (tx.stock_type) q = q.eq('stock_type', tx.stock_type)
          const { data: inv } = await q.maybeSingle()
          if (inv) {
            const restoredQty = inv.quantity - tx.quantity
            if (restoredQty <= 0) {
              await supabase.from('inventory').delete().eq('id', inv.id)
            } else {
              await supabase.from('inventory').update({ quantity: restoredQty, updated_at: new Date().toISOString() }).eq('id', inv.id)
            }
          }
        } else {
          // 출고 삭제: note에서 로트 정보 파싱해서 해당 로트로 복원
          // note 형식: "[로트] 260115-01 50개 / 260116-01 30개"
          const lotMatches = tx.note?.match(/(\d{6}-\d{2})\s+(\d+)개/g) || []

          if (lotMatches.length > 0) {
            // 로트별로 정확히 복원
            for (const match of lotMatches) {
              const m = match.match(/(\d{6}-\d{2})\s+(\d+)개/)
              if (!m) continue
              const lotNumber = m[1]
              const qty = parseInt(m[2])

              const { data: inv } = await supabase
                .from('inventory')
                .select('id, quantity')
                .eq('product_id', tx.product_id)
                .eq('warehouse_id', tx.warehouse_id)
                .eq('lot_number', lotNumber)
                .maybeSingle()

              if (inv) {
                await supabase.from('inventory')
                  .update({ quantity: inv.quantity + qty, updated_at: new Date().toISOString() })
                  .eq('id', inv.id)
              } else {
                // 로트가 완전히 소진돼서 row가 없으면 새로 생성
                await supabase.from('inventory').insert([{
                  product_id: tx.product_id,
                  warehouse_id: tx.warehouse_id,
                  quantity: qty,
                  lot_number: lotNumber,
                  stock_type: '일반',
                  company_id: profile?.company_id
                }])
              }
            }
          } else {
            // note에 로트 정보 없으면 가장 오래된 로트(FIFO)에 복원
            const { data: lots } = await supabase
              .from('inventory')
              .select('id, quantity, lot_number')
              .eq('product_id', tx.product_id)
              .eq('warehouse_id', tx.warehouse_id)
              .order('lot_number', { ascending: true })
              .limit(1)

            if (lots && lots.length > 0) {
              await supabase.from('inventory')
                .update({ quantity: lots[0].quantity + tx.quantity, updated_at: new Date().toISOString() })
                .eq('id', lots[0].id)
            } else {
              await supabase.from('inventory').insert([{
                product_id: tx.product_id,
                warehouse_id: tx.warehouse_id,
                quantity: tx.quantity,
                lot_number: null,
                stock_type: '일반',
                company_id: profile?.company_id
              }])
            }
          }
        }
      }

      // 트랜잭션 삭제
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
    <>
      <Navbar />
      <div className="min-h-screen bg-slate-50 pt-24 md:pt-20 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* 헤더 */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">입출고 관리</h1>
          </div>
          <button
            onClick={() => {
              if (!showForm) {
                const today = getTodayString()
                const [yyyy, mm, dd] = today.split('-')
                const prefix = `${yyyy.slice(-2)}${mm}${dd}-`
                setFormData(f => ({ ...f, transaction_date: today, lot_number: prefix }))
              }
              setShowForm(!showForm)
            }}
            className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition"
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
                <div className="flex gap-4 flex-wrap">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="입고"
                      checked={formData.type === '입고'}
                      onChange={(e) => setFormData({...formData, type: e.target.value, to_warehouse_id: '', sub_type: ''})}
                      className="mr-2"
                    />
                    <span className="text-green-600 font-medium">입고 (+)</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="출고"
                      checked={formData.type === '출고'}
                      onChange={(e) => setFormData({...formData, type: e.target.value, to_warehouse_id: '', sub_type: ''})}
                      className="mr-2"
                    />
                    <span className="text-red-600 font-medium">출고 (-)</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="이동"
                      checked={formData.type === '이동'}
                      onChange={(e) => setFormData({...formData, type: e.target.value, sub_type: ''})}
                      className="mr-2"
                    />
                    <span className="text-blue-600 font-medium">이동 (→)</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="조정"
                      checked={formData.type === '조정'}
                      onChange={(e) => setFormData({...formData, type: e.target.value, to_warehouse_id: '', sub_type: ''})}
                      className="mr-2"
                    />
                    <span className="text-orange-600 font-medium">조정 (실사)</span>
                  </label>
                </div>
                {formData.type === '조정' && (
                  <p className="text-xs text-orange-500 mt-1">실사 후 실제 수량을 입력하면 자동으로 차이를 조정합니다.</p>
                )}
              </div>
              {formData.type === '출고' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    출고 사유 *
                  </label>
                  <select
                    required
                    value={formData.sub_type}
                    onChange={(e) => setFormData({...formData, sub_type: e.target.value})}
                    className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    <option value="">사유 선택</option>
                    <option value="판매">판매</option>
                    <option value="샘플">샘플</option>
                    <option value="폐기">폐기</option>
                  </select>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {formData.type === '조정' ? '목표 수량 (실사 결과) *' : '수량 *'}
                </label>
                <input
                  type="number"
                  required
                  min={formData.type === '조정' ? '0' : '1'}
                  placeholder={formData.type === '조정' ? '실사 후 실제 수량 입력' : '예: 500'}
                  value={formData.quantity || ''}
                  onChange={(e) => setFormData({...formData, quantity: Number(e.target.value)})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  날짜 <span className="text-gray-400 font-normal">(기본: 오늘)</span>
                </label>
                <input
                  type="date"
                  value={formData.transaction_date || getTodayString()}
                  onChange={(e) => {
                    const newDate = e.target.value
                    const parts = newDate.split('-')
                    const prefix = parts.length === 3 ? `${parts[0].slice(-2)}${parts[1]}${parts[2]}-` : ''
                    setFormData({...formData, transaction_date: newDate, lot_number: prefix})
                  }}
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
                <>
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
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      재고 구분 *
                    </label>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setFormData({...formData, stock_type: '일반'})}
                        className={`flex-1 py-2 rounded-lg border-2 text-sm font-medium transition ${
                          formData.stock_type === '일반'
                            ? 'border-blue-500 bg-blue-50 text-blue-700'
                            : 'border-gray-200 text-gray-500 hover:border-gray-300'
                        }`}
                      >
                        일반
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormData({...formData, stock_type: '기획용'})}
                        className={`flex-1 py-2 rounded-lg border-2 text-sm font-medium transition ${
                          formData.stock_type === '기획용'
                            ? 'border-orange-500 bg-orange-50 text-orange-700'
                            : 'border-gray-200 text-gray-500 hover:border-gray-300'
                        }`}
                      >
                        기획용
                      </button>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">기획세트 출고 시 기획용 재고만 차감됩니다</p>
                  </div>
                  {formData.stock_type === '기획용' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        이번 입고 원가 <span className="text-gray-400 font-normal">(원/개)</span>
                      </label>
                      <input
                        type="number"
                        min="0"
                        placeholder="미입력 시 제품 기본원가 사용"
                        value={formData.lot_unit_cost}
                        onChange={(e) => setFormData({...formData, lot_unit_cost: e.target.value})}
                        className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
                      />
                      <p className="text-xs text-gray-400 mt-1">OEM 납품가가 기존과 다를 때 입력하세요</p>
                    </div>
                  )}
                </>
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
                  // 내부 이동인지 확인 (type이 '이동'이거나, note에 [이동] 또는 [샘플(이동)] 포함)
                  const isTransfer = tx.type === '이동' || tx.note?.includes('[이동]') || tx.note?.includes('[샘플(이동)]')
                  const displayType = isTransfer ? '이동' : tx.type

                  // 이동인 경우 note에서 창고 정보 추출 (형식: "창고A → 창고B" 또는 "창고A → 창고B (메모)")
                  let transferInfo = ''
                  let additionalNote = ''
                  if (isTransfer && tx.note) {
                    const match = tx.note.match(/^(.+?) → (.+?)(?:\s*\((.+)\))?$/)
                    if (match) {
                      transferInfo = `${match[1]} → ${match[2]}`
                      additionalNote = match[3] || ''
                    } else if (tx.note.includes('[이동]')) {
                      // 기존 형식: "[이동] 메모 → 창고명"
                      transferInfo = tx.note.replace('[이동]', '').trim()
                    } else {
                      transferInfo = tx.note
                    }
                  }

                  return (
                  <div key={tx.id} className="flex items-center justify-between border-b pb-4">
                    <div className="flex items-center gap-4">
                      <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                        isTransfer
                          ? 'bg-blue-100 text-blue-800'
                          : tx.type === '입고'
                          ? 'bg-green-100 text-green-800'
                          : tx.type === '조정'
                          ? 'bg-orange-100 text-orange-800'
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {displayType}
                        {tx.sub_type && ` (${tx.sub_type})`}
                      </span>
                      <div>
                        <p className="font-medium">
                          {tx.products?.product_name || '(삭제된 제품)'}
                        </p>
                        <p className="text-sm text-gray-500">
                          {isTransfer ? transferInfo : (
                            <>{tx.warehouses?.name} {tx.channel && `→ ${tx.channel}`}</>
                          )}
                        </p>
                        {isTransfer && additionalNote && (
                          <p className="text-sm text-gray-400">메모: {additionalNote}</p>
                        )}
                        {!isTransfer && (() => {
                          const lotMatch = tx.note?.match(/\[로트\] (.+)$/)
                          const lotInfo = lotMatch?.[1] ?? null
                          const userNote = tx.note
                            ? tx.note.replace(/\s*\|\s*\[로트\].*$/, '').replace(/^\[로트\].*$/, '').trim() || null
                            : null
                          return (
                            <>
                              {userNote && <p className="text-sm text-gray-400">메모: {userNote}</p>}
                              {lotInfo && <p className="text-xs text-gray-400">{lotInfo}</p>}
                            </>
                          )
                        })()}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className={`font-semibold text-lg ${
                          isTransfer
                            ? 'text-blue-600'
                            : tx.type === '입고'
                              ? 'text-green-600'
                              : tx.type === '조정'
                              ? 'text-orange-600'
                              : 'text-red-600'
                        }`}>
                          {isTransfer ? '↔' : tx.type === '입고' ? '+' : tx.type === '조정' ? (tx.quantity >= 0 ? '+' : '') : '-'}{tx.quantity.toLocaleString()}개
                        </p>
                        {tx.resulting_quantity !== null && tx.resulting_quantity !== undefined && (
                          <p className="text-xs text-gray-400">{tx.warehouses?.name} 잔액: {tx.resulting_quantity.toLocaleString()}개</p>
                        )}
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
    </>
  )
}
