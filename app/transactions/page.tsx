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

interface Channel {
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
  return_of_transaction_id: string | null
  evidence_file_url: string | null
  products: Product | null
  warehouses: Warehouse | null
}

interface ReturnSourceOption {
  id: string
  quantity: number
  channel: string | null
  created_at: string
}

export default function TransactionsPage() {
  const { profile } = useAuth()
  const [products, setProducts] = useState<Product[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
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
    lot_unit_cost: '',       // 이번 입고 원가 (기획용일 때 직접 입력, 빈값이면 제품 기본원가)
    return_of_transaction_id: '', // 반품 입고 시: 원 출고 건 참조 (근거 없는 반품 차단)
    quarantine: false,       // 반품 입고 시: 재판매 불가(격리) 처리 여부 — 실물 확인 후 담당자가 최종 판단
    internal_use_reason: '', // 내부사용 세부사유: 샘플/협찬/테스트/기타
    internal_use_recipient: '' // 내부사용 수령자
  })
  const [returnPhoto, setReturnPhoto] = useState<File | null>(null)
  const [returnSourceOptions, setReturnSourceOptions] = useState<ReturnSourceOption[]>([])

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

  // 반품 입고 자동판정(제안)용 — 출고 FIFO의 임박 기준(잔여 유통기한 25% 이하)과 동일 기준 재사용.
  // 반품통보서엔 로트가 안 적혀있어 실물 로트로만 판단 가능하므로, 최종 확정은 담당자 체크박스에 맡긴다.
  function suggestReturnQuarantine(lotNumber: string, shelfLifeMonths: number): boolean | null {
    if (!lotNumber || !/^\d{6}-\d{2}$/.test(lotNumber)) return null
    const y = parseInt('20' + lotNumber.substring(0, 2))
    const m = parseInt(lotNumber.substring(2, 4)) - 1
    const d = parseInt(lotNumber.substring(4, 6))
    const expiry = new Date(y, m, d)
    expiry.setMonth(expiry.getMonth() + shelfLifeMonths)
    const days = Math.ceil((expiry.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
    return days <= shelfLifeMonths * 30 * 0.25
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
  }, [profile?.company_id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!profile?.company_id) return

    const channel = supabase
      .channel(`transactions-realtime-${profile.company_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => fetchData())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [profile?.company_id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 반품 입고 선택 시: 근거 없는 반품 차단을 위해 참조할 원 출고 건 후보를 불러옴
  useEffect(() => {
    if (formData.type !== '입고' || formData.sub_type !== '반품' || !formData.product_id || !profile?.company_id) {
      setReturnSourceOptions([])
      return
    }
    supabase
      .from('transactions')
      .select('id, quantity, channel, created_at')
      .eq('company_id', profile.company_id)
      .eq('type', '출고')
      .eq('product_id', formData.product_id)
      .order('created_at', { ascending: false })
      .limit(30)
      .then(({ data }) => setReturnSourceOptions(data || []))
  }, [formData.type, formData.sub_type, formData.product_id, profile?.company_id])

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

    const { data: channelsData } = await supabase
      .from('channels')
      .select('id, name')
      .eq('company_id', cid)
      .order('name', { ascending: true })

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
    setChannels(channelsData || [])
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
      alert('출고 사유를 선택해주세요. (판매 / 내부사용 / 폐기)')
      return
    }

    // 내부사용인 경우 세부사유 + 수령자 필수 (무사유 반출 차단)
    if (formData.type === '출고' && formData.sub_type === '내부사용') {
      if (!formData.internal_use_reason || !formData.internal_use_recipient.trim()) {
        alert('내부사용 세부사유와 수령자를 입력해주세요.')
        return
      }
    }

    // 반품 입고인 경우 원 출고 건 참조 필수 (근거 없는 반품 입고 차단)
    if (formData.type === '입고' && formData.sub_type === '반품' && !formData.return_of_transaction_id) {
      alert('반품 대상 출고 건을 선택해주세요.')
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
        const isReturn = formData.sub_type === '반품'
        // 반품 입고: 격리 체크 시 '반품격리'로 별도 관리(정상 로트와 섞이지 않게), 아니면 원래 로트('일반')로 복원
        const effectiveStockType = isReturn ? (formData.quarantine ? '반품격리' : '일반') : formData.stock_type

        // 반품 박스 라벨 사진(선택) 업로드
        let returnPhotoUrl: string | null = null
        if (isReturn && returnPhoto) {
          const ext = returnPhoto.name.split('.').pop() || 'bin'
          const path = `${profile?.company_id}/returns/${Date.now()}.${ext}`
          const { error: uploadError } = await supabase.storage.from('evidence').upload(path, returnPhoto)
          if (uploadError) {
            alert('박스 라벨 사진 업로드 실패: ' + uploadError.message)
            return
          }
          returnPhotoUrl = path
        }

        // 입고: 제품+창고+로트번호+재고구분으로 로트 찾기 (재고구분까지 함께 봐야 일반/기획용/반품격리가 서로 안 섞임)
        const { data: existingInventory } = await supabase
          .from('inventory')
          .select('*')
          .eq('product_id', formData.product_id)
          .eq('warehouse_id', formData.warehouse_id)
          .eq('lot_number', formData.lot_number)
          .eq('stock_type', effectiveStockType)
          .maybeSingle()

        if (existingInventory) {
          await supabase
            .from('inventory')
            .update({
              quantity: existingInventory.quantity + formData.quantity,
              stock_type: effectiveStockType,
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
              stock_type: effectiveStockType,
              lot_unit_cost: formData.lot_unit_cost !== '' ? Number(formData.lot_unit_cost) : null,
              company_id: profile?.company_id
            }])
        }

        // 입고 기록 저장
        const inboundResultingQty = await getTotalInventory(formData.product_id, formData.warehouse_id)
        const returnSource = isReturn ? returnSourceOptions.find(o => o.id === formData.return_of_transaction_id) : null
        const returnNote = isReturn
          ? `[반품] 원출고 ${returnSource ? `${new Date(returnSource.created_at).toLocaleDateString('ko-KR')} ${returnSource.quantity.toLocaleString()}개${returnSource.channel ? ` (${returnSource.channel})` : ''}` : ''}${formData.quarantine ? ' · 격리(재판매 불가)' : ''}`
          : null
        const { error: txError } = await supabase
          .from('transactions')
          .insert([{
            product_id: formData.product_id,
            warehouse_id: formData.warehouse_id,
            type: '입고',
            sub_type: isReturn ? '반품' : null,
            quantity: formData.quantity,
            resulting_quantity: inboundResultingQty,
            lot_number: formData.lot_number || null,
            stock_type: effectiveStockType || '일반',
            channel: formData.channel || null,
            note: isReturn ? (formData.note ? `${formData.note} | ${returnNote}` : returnNote) : (formData.note || null),
            recorded_by: profile?.name || null,
            created_at: transactionDate,
            company_id: profile?.company_id,
            return_of_transaction_id: isReturn ? formData.return_of_transaction_id : null,
            evidence_file_url: returnPhotoUrl
          }])
        if (txError) { alert('기록 실패: ' + txError.message); return }
      } else {
        // 출고: 만료/임박 로트 제외, 정상 로트만 FIFO (로트번호 오름차순)
        const { data: inventoryLots } = await supabase
          .from('inventory')
          .select('id, quantity, lot_number, stock_type')
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

        // 반품격리 재고(재판매 불가 판정)는 일반 출고(판매/샘플)에서 제외 — 재출고→재반품 악순환 방지.
        // 폐기는 격리재고를 정리(불용재고 처리)하는 목적이라 예외적으로 포함시킨다.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isQuarantined = (lot: any): boolean => lot.stock_type === '반품격리' && formData.sub_type !== '폐기'

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eligible = (inventoryLots || [])
          .filter((lot: any) => !isExpiredOrWarning(lot) && !isQuarantined(lot))
          .sort((a: any, b: any) => {
            if (a.lot_number && b.lot_number) return a.lot_number.localeCompare(b.lot_number)
            return 0
          })
        console.log('[FIFO] eligible lots:', eligible)

        const eligibleTotal = eligible.reduce((sum: number, lot: any) => sum + lot.quantity, 0)
        if (eligibleTotal < formData.quantity) {
          alert(`출고 가능 재고 부족!\n\n만료/임박/격리 로트 제외 후 가용 재고: ${eligibleTotal.toLocaleString()}개\n요청: ${formData.quantity.toLocaleString()}개\n\n(만료/임박 로트 및 반품격리 로트는 일반 출고에서 제외됩니다)`)
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
        const internalUseNote = formData.sub_type === '내부사용'
          ? `[내부사용:${formData.internal_use_reason}] 수령자: ${formData.internal_use_recipient.trim()}`
          : null
        const finalNote = [formData.note, internalUseNote, lotNote].filter(Boolean).join(' | ')
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
      lot_unit_cost: '',
      return_of_transaction_id: '',
      quarantine: false,
      internal_use_reason: '',
      internal_use_recipient: ''
    })
    setReturnPhoto(null)
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
      <div className="min-h-screen bg-slate-50 pt-28 md:pt-20 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* 헤더 */}
        <div className="flex flex-wrap justify-between items-start gap-3 mb-6">
          <h1 className="text-xl font-bold text-gray-900">입출고 관리</h1>
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
            className="bg-blue-600 text-white px-3 py-1.5 md:px-5 md:py-2 text-sm rounded-lg hover:bg-blue-700 transition shrink-0"
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
                    onChange={(e) => setFormData({...formData, sub_type: e.target.value, internal_use_reason: '', internal_use_recipient: ''})}
                    className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
                  >
                    <option value="">사유 선택</option>
                    <option value="판매">판매</option>
                    <option value="내부사용">내부사용</option>
                    <option value="폐기">폐기</option>
                  </select>
                </div>
              )}
              {formData.type === '출고' && formData.sub_type === '내부사용' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      내부사용 세부사유 *
                    </label>
                    <select
                      required
                      value={formData.internal_use_reason}
                      onChange={(e) => setFormData({...formData, internal_use_reason: e.target.value})}
                      className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
                    >
                      <option value="">세부사유 선택</option>
                      <option value="샘플">샘플</option>
                      <option value="협찬">협찬</option>
                      <option value="테스트">테스트</option>
                      <option value="기타">기타</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      수령자 *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="예: 마케팅팀 김민지"
                      value={formData.internal_use_recipient}
                      onChange={(e) => setFormData({...formData, internal_use_recipient: e.target.value})}
                      className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
                    />
                  </div>
                </>
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
                {channels.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    등록된 채널이 없습니다. <a href="/settings/channels" className="text-blue-600 hover:underline">채널 관리에서 먼저 등록해주세요 →</a>
                  </p>
                ) : (
                  <select
                    value={formData.channel}
                    onChange={(e) => setFormData({...formData, channel: e.target.value})}
                    className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="">채널 선택 (출고 시)</option>
                    {channels.map((c) => (
                      <option key={c.id} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                )}
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
                      입고 구분 *
                    </label>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setFormData({...formData, sub_type: ''})}
                        className={`flex-1 py-2 rounded-lg border-2 text-sm font-medium transition ${
                          formData.sub_type !== '반품'
                            ? 'border-green-500 bg-green-50 text-green-700'
                            : 'border-gray-200 text-gray-500 hover:border-gray-300'
                        }`}
                      >
                        일반 입고
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormData({...formData, sub_type: '반품', return_of_transaction_id: ''})}
                        className={`flex-1 py-2 rounded-lg border-2 text-sm font-medium transition ${
                          formData.sub_type === '반품'
                            ? 'border-purple-500 bg-purple-50 text-purple-700'
                            : 'border-gray-200 text-gray-500 hover:border-gray-300'
                        }`}
                      >
                        반품 입고
                      </button>
                    </div>
                  </div>
                  {formData.sub_type === '반품' ? (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          반품 대상 출고 건 *
                        </label>
                        {returnSourceOptions.length === 0 ? (
                          <p className="text-sm text-gray-500">이 제품의 출고 기록이 없습니다. 제품을 먼저 선택해주세요.</p>
                        ) : (
                          <select
                            required
                            value={formData.return_of_transaction_id}
                            onChange={(e) => setFormData({...formData, return_of_transaction_id: e.target.value})}
                            className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500"
                          >
                            <option value="">출고 건 선택</option>
                            {returnSourceOptions.map(o => (
                              <option key={o.id} value={o.id}>
                                {new Date(o.created_at).toLocaleDateString('ko-KR')} · {o.quantity.toLocaleString()}개{o.channel ? ` · ${o.channel}` : ''}
                              </option>
                            ))}
                          </select>
                        )}
                        <p className="text-xs text-gray-400 mt-1">근거 없는 반품 입고를 막기 위해, 어느 출고 건의 반품인지 반드시 연결합니다.</p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          박스 라벨 사진 <span className="text-gray-400 font-normal">(선택)</span>
                        </label>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => setReturnPhoto(e.target.files?.[0] || null)}
                          className="text-sm"
                        />
                      </div>
                      <div className="md:col-span-2 bg-purple-50 border border-purple-200 rounded-lg p-3">
                        {(() => {
                          const selectedProduct = products.find(p => p.id === formData.product_id)
                          const shelfLifeMonths = selectedProduct?.shelf_life_months || 24
                          const suggested = suggestReturnQuarantine(formData.lot_number, shelfLifeMonths)
                          return (
                            <p className="text-xs text-purple-700 mb-2">
                              {suggested === null
                                ? '로트번호를 입력하면 잔여 유통기한 기준 자동판정을 안내합니다.'
                                : suggested
                                ? '자동판정: 임박/만료 로트 — 격리 처리를 권장합니다. 실물 확인 후 최종 결정해주세요.'
                                : '자동판정: 재판매 가능 — 정상 로트로 복원됩니다.'}
                            </p>
                          )
                        })()}
                        <label className="flex items-center text-sm">
                          <input
                            type="checkbox"
                            checked={formData.quarantine}
                            onChange={(e) => setFormData({...formData, quarantine: e.target.checked})}
                            className="mr-2"
                          />
                          격리 처리 (재판매 불가 — 정상 재고와 분리해 일반 출고에서 제외)
                        </label>
                      </div>
                    </>
                  ) : (
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
                  )}
                  {formData.stock_type === '기획용' && formData.sub_type !== '반품' && (
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
          <div className="p-3 md:p-6 border-b">
            <h2 className="text-base md:text-xl font-semibold">입출고 기록 ({transactions.length}건)</h2>
          </div>
          <div className="p-3 md:p-6">
            {transactions.length === 0 ? (
              <p className="text-gray-500 text-center py-8">
                입출고 기록이 없습니다.
              </p>
            ) : (
              <div className="space-y-1">
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
                  <div key={tx.id} className="flex items-center justify-between border-b py-1">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium shrink-0 ${
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
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">
                          {tx.products?.product_name || '(삭제된 제품)'}
                        </p>
                        <p className="text-xs text-gray-500">
                          {isTransfer ? transferInfo : (
                            <>{tx.warehouses?.name} {tx.channel && `→ ${tx.channel}`}</>
                          )}
                        </p>
                        {isTransfer && additionalNote && (
                          <p className="text-xs text-gray-400">메모: {additionalNote}</p>
                        )}
                        {tx.stock_type === '반품격리' && (
                          <p className="text-xs text-purple-600 font-medium">🔒 격리 재고 (재판매 불가)</p>
                        )}
                        {!isTransfer && (() => {
                          const lotMatch = tx.note?.match(/\[로트\] (.+)$/)
                          const lotInfo = lotMatch?.[1] ?? null
                          const returnMatch = tx.note?.match(/\[반품\] (.+?)(?:\s*\|\s*\[로트\]|$)/)
                          const returnInfo = returnMatch?.[1] ?? null
                          const internalUseMatch = tx.note?.match(/\[내부사용:([^\]]+)\] (.+?)(?:\s*\|\s*\[로트\]|$)/)
                          const internalUseInfo = internalUseMatch ? `${internalUseMatch[1]} · ${internalUseMatch[2]}` : null
                          const userNote = tx.note
                            ? tx.note
                                .replace(/\s*\|\s*\[로트\].*$/, '')
                                .replace(/^\[로트\].*$/, '')
                                .replace(/\s*\|\s*\[반품\].*$/, '')
                                .replace(/^\[반품\].*$/, '')
                                .replace(/\s*\|\s*\[내부사용:[^\]]+\].*$/, '')
                                .replace(/^\[내부사용:[^\]]+\].*$/, '')
                                .trim() || null
                            : null
                          return (
                            <>
                              {userNote && <p className="text-xs text-gray-400">메모: {userNote}</p>}
                              {returnInfo && <p className="text-xs text-purple-500">반품: {returnInfo}</p>}
                              {internalUseInfo && <p className="text-xs text-amber-600">내부사용: {internalUseInfo}</p>}
                              {lotInfo && <p className="text-xs text-gray-400">{lotInfo}</p>}
                            </>
                          )
                        })()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right">
                        <p className={`font-semibold text-sm ${
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
                          <p className="text-xs text-gray-400">잔액 {tx.resulting_quantity.toLocaleString()}개</p>
                        )}
                        <p className="text-xs text-gray-500">
                          {new Date(tx.created_at).toLocaleDateString('ko-KR')}
                        </p>
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
