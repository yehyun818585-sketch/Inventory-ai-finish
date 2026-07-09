'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'
import { getInboundReconciliation, getOutboundReconciliation, getTransferReconciliation, ReconciliationProgressRow } from '@/lib/reconciliation'

type DocType = '발주품의서' | '출고지시서' | '이동품의서'
type Status = '대기' | '승인' | '반려'

interface Product {
  id: string
  product_name: string
  product_code: string
}

interface Warehouse {
  id: string
  name: string
}

interface Supplier {
  id: string
  name: string
  contact_email: string | null
}

interface DocItem {
  id: string
  product_id: string
  quantity: number
  products: { product_name: string; product_code: string } | null
}

interface ApprovalStep {
  id: string
  step_order: number
  status: Status
  acted_by_name: string | null
  acted_at: string | null
}

interface ApprovalDocument {
  id: string
  doc_type: DocType
  status: Status
  warehouse_id: string | null
  to_warehouse_id: string | null
  channel: string | null
  memo: string | null
  expected_date: string | null
  confirmed_date: string | null
  supplier_name: string | null
  supplier_id: string | null
  order_number: string | null
  requested_by: string | null
  requested_by_user_id: string | null
  approved_by: string | null
  approved_at: string | null
  created_at: string
  warehouses: { name: string } | null
  to_warehouse: { name: string } | null
  approval_document_items: DocItem[]
  approval_steps: ApprovalStep[]
}

interface ItemRow {
  product_id: string
  quantity: number
  isNew: boolean
  newProductName: string
  unit_price: string
}

const DOC_TYPES: DocType[] = ['발주품의서', '출고지시서', '이동품의서']
const STATUS_TABS: Status[] = ['대기', '승인', '반려']

export default function ApprovalsPage() {
  const { profile } = useAuth()
  const router = useRouter()
  const [products, setProducts] = useState<Product[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [documents, setDocuments] = useState<ApprovalDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [docTypeTab, setDocTypeTab] = useState<DocType>('발주품의서')
  const [statusTab, setStatusTab] = useState<Status>('대기')

  const [formData, setFormData] = useState({
    doc_type: '발주품의서' as DocType,
    warehouse_id: '',
    to_warehouse_id: '',
    channel: '',
    memo: '',
    expected_date: '',
    supplier_id: ''
  })
  const [items, setItems] = useState<ItemRow[]>([{ product_id: '', quantity: 0, isNew: false, newProductName: '', unit_price: '' }])
  const [saving, setSaving] = useState(false)
  const [progressMap, setProgressMap] = useState<Record<string, ReconciliationProgressRow>>({})

  // 출고지시서 전용: 채널 발주 근거서류 (자사몰=엑셀 자동집계, 그 외=수동입력+파일첨부)
  const [channelMode, setChannelMode] = useState<'자사몰' | '그 외'>('그 외')
  const [channelOrderFile, setChannelOrderFile] = useState<File | null>(null)
  const [parsingFile, setParsingFile] = useState(false)
  const [unmatchedNames, setUnmatchedNames] = useState<string[]>([])
  const [shippingCutoffTime, setShippingCutoffTime] = useState('15:00')
  const [batchOrderAt, setBatchOrderAt] = useState<Date | null>(null)

  useEffect(() => {
    fetchData()
  }, [profile?.company_id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!profile?.company_id) return
    const channel = supabase
      .channel(`approvals-realtime-${profile.company_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'approval_documents' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'approval_document_items' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'approval_steps' }, () => fetchData())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile?.company_id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!profile?.company_id) return
    loadProgress(docTypeTab)
  }, [docTypeTab, profile?.company_id, documents]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadProgress(docType: DocType) {
    if (!profile?.company_id) return
    const { progress } = docType === '발주품의서'
      ? await getInboundReconciliation(profile.company_id)
      : docType === '출고지시서'
      ? await getOutboundReconciliation(profile.company_id)
      : await getTransferReconciliation(profile.company_id)
    const map: Record<string, ReconciliationProgressRow> = {}
    progress.forEach(p => { map[`${p.document_id}::${p.product_id}`] = p })
    setProgressMap(map)
  }

  async function fetchData() {
    if (!profile?.company_id) return
    setLoading(true)
    const cid = profile.company_id

    const { data: productsData } = await supabase
      .from('products')
      .select('id, product_name, product_code')
      .eq('company_id', cid)
      .eq('is_active', true)

    const { data: warehousesData } = await supabase
      .from('warehouses')
      .select('id, name')
      .eq('company_id', cid)

    const { data: suppliersData } = await supabase
      .from('suppliers')
      .select('id, name, contact_email')
      .eq('company_id', cid)
      .order('name', { ascending: true })

    const { data: companyData } = await supabase
      .from('companies')
      .select('shipping_cutoff_time')
      .eq('id', cid)
      .single()
    setShippingCutoffTime((companyData?.shipping_cutoff_time || '15:00').slice(0, 5))

    const { data: documentsData } = await supabase
      .from('approval_documents')
      .select(`
        id, doc_type, status, warehouse_id, to_warehouse_id, channel, memo, expected_date,
        confirmed_date, supplier_name, supplier_id, order_number,
        requested_by, requested_by_user_id, approved_by, approved_at, created_at,
        warehouses:warehouse_id (name),
        to_warehouse:to_warehouse_id (name),
        approval_document_items ( id, product_id, quantity, products (product_name, product_code) ),
        approval_steps ( id, step_order, status, acted_by_name, acted_at )
      `)
      .eq('company_id', cid)
      .order('created_at', { ascending: false })

    setProducts(productsData || [])
    setWarehouses(warehousesData || [])
    setSuppliers(suppliersData || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setDocuments((documentsData as any) || [])
    setLoading(false)
  }

  function addItemRow() {
    setItems([...items, { product_id: '', quantity: 0, isNew: false, newProductName: '', unit_price: '' }])
  }

  function updateItemRow(idx: number, field: keyof ItemRow, value: string | number | boolean) {
    const updated = [...items]
    updated[idx] = { ...updated[idx], [field]: value }
    setItems(updated)
  }

  function removeItemRow(idx: number) {
    setItems(items.filter((_, i) => i !== idx))
  }

  function resetForm() {
    setFormData({ doc_type: '발주품의서', warehouse_id: '', to_warehouse_id: '', channel: '', memo: '', expected_date: '', supplier_id: '' })
    setItems([{ product_id: '', quantity: 0, isNew: false, newProductName: '', unit_price: '' }])
    setChannelMode('그 외')
    setChannelOrderFile(null)
    setUnmatchedNames([])
    setBatchOrderAt(null)
    setShowForm(false)
  }

  // 새 제품이면 이름으로 찾아서 없으면 생성(온보딩 페이지의 실사입력 upsert 패턴과 동일), 기존 제품이면 그대로 id 반환
  async function resolveProductId(item: ItemRow, cid: string): Promise<string | null> {
    if (!item.isNew) return item.product_id || null
    const name = item.newProductName.trim()
    if (!name) return null

    const { data: existing } = await supabase
      .from('products')
      .select('id')
      .ilike('product_name', name)
      .eq('company_id', cid)
      .maybeSingle()
    if (existing) return existing.id

    const { data: created } = await supabase
      .from('products')
      .insert([{
        product_name: name,
        product_code: name.toUpperCase().replace(/\s+/g, '-').slice(0, 10),
        product_group: '미분류',
        is_active: true,
        company_id: cid
      }])
      .select('id')
      .single()
    return created?.id || null
  }

  // 발주번호 자동생성: PO-YYMMDD-NN (로트번호와 혼동되지 않도록 PO- 접두어 부여, 날짜는 기안 제출일)
  async function generateOrderNumber(cid: string): Promise<string> {
    const today = new Date()
    const datePart = `${String(today.getFullYear()).slice(2)}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
    const prefix = `PO-${datePart}`
    const { data } = await supabase
      .from('approval_documents')
      .select('order_number')
      .eq('company_id', cid)
      .eq('doc_type', '발주품의서')
      .like('order_number', `${prefix}-%`)

    const maxSeq = (data || []).reduce((max, d) => {
      const seq = parseInt(d.order_number?.split('-')[2] || '0', 10)
      return Number.isNaN(seq) ? max : Math.max(max, seq)
    }, 0)
    return `${prefix}-${String(maxSeq + 1).padStart(2, '0')}`
  }

  // 자사몰 "신규주문 엑셀 다운로드" 파일을 파싱해 상품별 수량을 합산하고 품목을 자동으로 채움.
  // 매칭 안 되는 상품명은 unmatchedNames로 모아서 안내(수동으로 품목 추가 필요).
  async function parseChannelOrderExcel(file: File) {
    setParsingFile(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheet = wb.Sheets[wb.SheetNames[0]]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' })

      const aggregated: Record<string, number> = {}
      const unmatched: string[] = []
      let latestOrderAt: Date | null = null

      rows.forEach(row => {
        const orderNo = String(row['주문번호'] || row['상품주문번호'] || '').trim()
        if (!orderNo) return // 합계 행 등은 주문번호가 없어서 자동 스킵됨

        const name = String(row['상품명'] || '').trim()
        const option = String(row['옵션정보'] || '').trim()
        const qty = Number(row['수량'] || 0)
        if (!name || qty <= 0) return

        const orderAtRaw = String(row['주문일시'] || row['결제일시'] || '').trim()
        if (orderAtRaw) {
          const parsed = new Date(orderAtRaw.replace(' ', 'T'))
          if (!isNaN(parsed.getTime()) && (!latestOrderAt || parsed > latestOrderAt)) {
            latestOrderAt = parsed
          }
        }

        const combined = `${name} ${option}`.toUpperCase()
        const matched = products.find(p =>
          combined.includes(p.product_code.toUpperCase()) || p.product_name === name
        )

        if (matched) {
          aggregated[matched.id] = (aggregated[matched.id] || 0) + qty
        } else if (!unmatched.includes(name)) {
          unmatched.push(name)
        }
      })

      const newItems: ItemRow[] = Object.entries(aggregated).map(([product_id, quantity]) => ({
        product_id, quantity, isNew: false, newProductName: '', unit_price: ''
      }))

      if (newItems.length > 0) setItems(newItems)
      setUnmatchedNames(unmatched)
      setBatchOrderAt(latestOrderAt)
    } catch {
      alert('엑셀 파싱에 실패했습니다. 파일 형식을 확인해주세요.')
    } finally {
      setParsingFile(false)
    }
  }

  // 출고지시서 전용: 확정일은 "기안하는 시각"이 아니라 "그 배치 안 주문들이 마감 전/후 건이냐"로 정해야 한다.
  // 마감 직후에 기안해도 그 배치가 마감 전 주문이면 당일 출고이고, 반대로 마감 한참 후 주문을
  // 퇴근 전에 미리 기안해둬도 그 주문 자체가 마감 후 건이면 익일 출고이기 때문 — 그래서 기준 시각을
  // "지금(now)"이 아니라 엑셀에서 뽑은 "배치 내 최신 주문일시"로 받는다.
  function computeOutboundConfirmedDate(cutoffTime: string, referenceDate: Date): string {
    const [h, m] = cutoffTime.split(':').map(Number)
    const cutoff = new Date(referenceDate)
    cutoff.setHours(h, m, 0, 0)
    const target = new Date(referenceDate)
    if (referenceDate > cutoff) target.setDate(target.getDate() + 1)
    const y = target.getFullYear()
    const mo = String(target.getMonth() + 1).padStart(2, '0')
    const d = String(target.getDate()).padStart(2, '0')
    return `${y}-${mo}-${d}`
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const validItems = items.filter(i => (i.isNew ? i.newProductName.trim() : i.product_id) && i.quantity > 0)
    if (validItems.length === 0) {
      alert('제품과 수량을 하나 이상 입력해주세요.')
      return
    }
    if (!formData.warehouse_id) {
      alert('창고를 선택해주세요.')
      return
    }
    if (formData.doc_type === '이동품의서' && !formData.to_warehouse_id) {
      alert('도착 창고를 선택해주세요.')
      return
    }
    if (formData.doc_type === '발주품의서' && !formData.expected_date) {
      alert('희망 납기일을 입력해주세요.')
      return
    }
    // 출고지시서: 자사몰은 마감시간 기준 자동계산이라 별도 입력 불필요, 그 외(올리브영 등)는
    // 거래처 발주서에 이미 날짜가 있으니 수동 입력을 그대로 요구한다.
    if (formData.doc_type === '출고지시서' && channelMode === '그 외' && !formData.expected_date) {
      alert('확정 출고일을 입력해주세요.')
      return
    }
    const selectedSupplier = suppliers.find(s => s.id === formData.supplier_id)
    if (formData.doc_type === '발주품의서' && !selectedSupplier) {
      alert('거래처를 선택해주세요.')
      return
    }
    if (formData.doc_type === '출고지시서' && !channelOrderFile) {
      alert('채널 발주 근거서류(엑셀/PDF)를 첨부해주세요.')
      return
    }

    setSaving(true)
    try {
      const cid = profile?.company_id || ''
      const orderNumber = formData.doc_type === '발주품의서' ? await generateOrderNumber(cid) : null

      let channelOrderFileUrl: string | null = null
      if (formData.doc_type === '출고지시서' && channelOrderFile) {
        const ext = channelOrderFile.name.split('.').pop() || 'bin'
        const path = `${cid}/channel-order/${Date.now()}.${ext}`
        const { error: uploadError } = await supabase.storage.from('evidence').upload(path, channelOrderFile)
        if (uploadError) {
          alert('채널 발주 근거서류 업로드 실패: ' + uploadError.message)
          return
        }
        channelOrderFileUrl = path
      }

      // 출고지시서 확정일: 자사몰은 마감시간 규칙으로 자동계산, 그 외(올리브영 등)는 거래처
      // 발주서에 이미 날짜가 있으니 기안 시점에 입력한 값을 그대로 확정일로 씀(별도 확정 절차 불필요).
      const outboundDate = formData.doc_type === '출고지시서'
        ? (channelMode === '자사몰' ? computeOutboundConfirmedDate(shippingCutoffTime, batchOrderAt || new Date()) : formData.expected_date)
        : null

      const { data: doc, error: docError } = await supabase
        .from('approval_documents')
        .insert([{
          company_id: cid,
          doc_type: formData.doc_type,
          status: '대기',
          warehouse_id: formData.warehouse_id,
          to_warehouse_id: formData.doc_type === '이동품의서' ? formData.to_warehouse_id : null,
          channel: formData.doc_type === '출고지시서' ? (formData.channel || null) : null,
          channel_order_file_url: channelOrderFileUrl,
          memo: formData.memo || null,
          expected_date: formData.doc_type === '발주품의서' ? formData.expected_date : outboundDate,
          confirmed_date: outboundDate,
          supplier_id: formData.doc_type === '발주품의서' ? selectedSupplier!.id : null,
          supplier_name: formData.doc_type === '발주품의서' ? selectedSupplier!.name : null,
          order_number: orderNumber,
          requested_by: profile?.name || null,
          requested_by_user_id: profile?.id || null
        }])
        .select('id')
        .single()

      if (docError || !doc) {
        alert('기안 실패: ' + docError?.message)
        return
      }

      const resolvedItems = await Promise.all(validItems.map(async i => ({
        product_id: await resolveProductId(i, cid),
        quantity: i.quantity,
        unit_price: i.unit_price !== '' ? Number(i.unit_price) : null
      })))

      if (resolvedItems.some(i => !i.product_id)) {
        alert('신규 제품명을 확인해주세요.')
        return
      }

      const { error: itemsError } = await supabase
        .from('approval_document_items')
        .insert(resolvedItems.map(i => ({
          document_id: doc.id,
          product_id: i.product_id,
          quantity: i.quantity,
          unit_price: i.unit_price
        })))

      if (itemsError) {
        alert('품목 저장 실패: ' + itemsError.message)
        return
      }

      // 결재선 1단계 생성 (나중에 단계를 늘리려면 여기서 여러 행을 insert하면 됨)
      const { error: stepError } = await supabase
        .from('approval_steps')
        .insert([{ document_id: doc.id, step_order: 1, status: '대기' }])

      if (stepError) {
        alert('결재선 생성 실패: ' + stepError.message)
        return
      }

      // 승인자(관리책임자/대표, 본인 제외)에게 결재요청 알림
      const { data: approvers, error: approversError } = await supabase
        .from('profiles')
        .select('id')
        .eq('company_id', cid)
        .in('position', ['관리책임자', '대표'])
        .neq('id', profile?.id || '')

      if (approversError) {
        console.error('승인자 조회 실패:', approversError)
      } else if (approvers && approvers.length > 0) {
        const { error: notifyError } = await supabase.from('notifications').insert(approvers.map(a => ({
          company_id: cid,
          recipient_user_id: a.id,
          document_id: doc.id,
          type: '결재요청',
          message: `${formData.doc_type} 승인 요청${orderNumber ? ` (${orderNumber})` : ''}`
        })))
        if (notifyError) console.error('결재요청 알림 발송 실패:', notifyError)
      }

      resetForm()
      router.push(`/approvals/${doc.id}`)
    } finally {
      setSaving(false)
    }
  }

  const isApprover = profile?.position === '관리책임자' || profile?.position === '대표'
  const filteredDocs = documents.filter(d => d.doc_type === docTypeTab && d.status === statusTab)

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
          <div className="flex flex-wrap justify-between items-start gap-3 mb-6">
            <h1 className="text-xl font-bold text-gray-900">결재 (품의서)</h1>
            <button
              onClick={() => setShowForm(!showForm)}
              className="bg-blue-600 text-white px-3 py-1.5 md:px-5 md:py-2 text-sm rounded-lg hover:bg-blue-700 transition shrink-0"
            >
              {showForm ? '취소' : '+ 기안'}
            </button>
          </div>

          {showForm && (
            <div className="bg-white rounded-lg shadow p-6 mb-8">
              <h2 className="text-xl font-semibold mb-4">품의서 기안</h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">문서 유형 *</label>
                  <div className="flex gap-4 flex-wrap">
                    {DOC_TYPES.map(dt => (
                      <label key={dt} className="flex items-center">
                        <input
                          type="radio"
                          value={dt}
                          checked={formData.doc_type === dt}
                          onChange={() => {
                            setFormData({ ...formData, doc_type: dt, to_warehouse_id: '', channel: '' })
                            setChannelOrderFile(null)
                            setUnmatchedNames([])
                            setBatchOrderAt(null)
                            setChannelMode('그 외')
                          }}
                          className="mr-2"
                        />
                        <span className="font-medium">{dt}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {formData.doc_type === '발주품의서' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">거래처 *</label>
                      {suppliers.length === 0 ? (
                        <p className="text-sm text-gray-500">
                          등록된 거래처가 없습니다. <Link href="/settings/suppliers" className="text-blue-600 hover:underline">거래처 관리에서 먼저 등록해주세요 →</Link>
                        </p>
                      ) : (
                        <select
                          required
                          value={formData.supplier_id}
                          onChange={(e) => setFormData({ ...formData, supplier_id: e.target.value })}
                          className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          <option value="">거래처 선택</option>
                          {suppliers.map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {formData.doc_type === '이동품의서' ? '출발 창고 *' : formData.doc_type === '발주품의서' ? '입고 대상 창고 *' : '출고 창고 *'}
                    </label>
                    <select
                      required
                      value={formData.warehouse_id}
                      onChange={(e) => setFormData({ ...formData, warehouse_id: e.target.value })}
                      className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">창고 선택</option>
                      {warehouses.map(w => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                  </div>

                  {formData.doc_type === '이동품의서' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">도착 창고 *</label>
                      <select
                        required
                        value={formData.to_warehouse_id}
                        onChange={(e) => setFormData({ ...formData, to_warehouse_id: e.target.value })}
                        className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="">창고 선택</option>
                        {warehouses.filter(w => w.id !== formData.warehouse_id).map(w => (
                          <option key={w.id} value={w.id}>{w.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {formData.doc_type === '출고지시서' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">채널</label>
                      <input
                        type="text"
                        placeholder="예: 올리브영, 자사몰(카페24)"
                        value={formData.channel}
                        onChange={(e) => setFormData({ ...formData, channel: e.target.value })}
                        className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  )}

                  {formData.doc_type === '발주품의서' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">희망 납기일(요청) *</label>
                      <input
                        type="date"
                        required
                        value={formData.expected_date}
                        onChange={(e) => setFormData({ ...formData, expected_date: e.target.value })}
                        className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <p className="text-xs text-gray-400 mt-1">정식 날짜는 거래처 확인 후 문서 상세에서 별도로 확정합니다. 확정 전까지는 지연 알림 대상이 아닙니다.</p>
                    </div>
                  )}

                  {formData.doc_type === '출고지시서' && channelMode === '그 외' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">확정 출고일 *</label>
                      <input
                        type="date"
                        required
                        value={formData.expected_date}
                        onChange={(e) => setFormData({ ...formData, expected_date: e.target.value })}
                        className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <p className="text-xs text-gray-400 mt-1">거래처 발주서에 적힌 날짜를 그대로 입력하세요. 별도 확정 절차 없이 이 값이 바로 확정일로 저장됩니다.</p>
                    </div>
                  )}

                  {formData.doc_type === '출고지시서' && channelMode === '자사몰' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">확정 출고일</label>
                      <p className="border rounded-lg px-4 py-2 bg-gray-50 text-gray-700">
                        {batchOrderAt
                          ? `${computeOutboundConfirmedDate(shippingCutoffTime, batchOrderAt)} (자동 계산됨)`
                          : '엑셀 첨부 후 자동으로 표시됩니다'}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        배치 안 최신 주문일시가 배송 마감시간({shippingCutoffTime}) 전이면 당일, 후면 익일로 자동 계산됩니다.
                      </p>
                    </div>
                  )}
                </div>

                {formData.doc_type === '출고지시서' && (
                  <div className="border rounded-lg p-4 bg-gray-50">
                    <label className="block text-sm font-medium text-gray-700 mb-2">채널 발주 근거서류 *</label>
                    <div className="flex gap-4 mb-3">
                      <label className="flex items-center text-sm">
                        <input
                          type="radio"
                          checked={channelMode === '자사몰'}
                          onChange={() => { setChannelMode('자사몰'); setChannelOrderFile(null); setUnmatchedNames([]); setBatchOrderAt(null) }}
                          className="mr-1.5"
                        />
                        자사몰 (엑셀 자동집계)
                      </label>
                      <label className="flex items-center text-sm">
                        <input
                          type="radio"
                          checked={channelMode === '그 외'}
                          onChange={() => { setChannelMode('그 외'); setChannelOrderFile(null); setUnmatchedNames([]); setBatchOrderAt(null) }}
                          className="mr-1.5"
                        />
                        그 외(올리브영 등, 수동입력)
                      </label>
                    </div>

                    <input
                      type="file"
                      accept={channelMode === '자사몰' ? '.xlsx,.xls' : '.xlsx,.xls,.pdf,image/*'}
                      onChange={(e) => {
                        const file = e.target.files?.[0] || null
                        setChannelOrderFile(file)
                        if (file && channelMode === '자사몰') parseChannelOrderExcel(file)
                      }}
                      className="text-sm"
                    />
                    {parsingFile && <p className="text-xs text-gray-500 mt-1">엑셀 분석 중...</p>}
                    {channelMode === '자사몰' && channelOrderFile && !parsingFile && (
                      <p className="text-xs text-green-600 mt-1">품목이 자동으로 합산되어 아래에 채워졌습니다. 내용을 확인해주세요.</p>
                    )}
                    {unmatchedNames.length > 0 && (
                      <p className="text-xs text-orange-600 mt-1">
                        자동 매칭 안 된 상품: {unmatchedNames.join(', ')} — 아래에서 수동으로 품목을 추가해주세요.
                      </p>
                    )}
                    <p className="text-xs text-gray-400 mt-1">
                      {channelMode === '자사몰'
                        ? '카페24 등에서 다운로드한 "신규주문 엑셀"을 그대로 첨부하세요.'
                        : '벤더 포털에서 받은 발주서(엑셀/PDF)를 첨부하고, 품목은 아래에 직접 입력하세요.'}
                    </p>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">품목 *</label>
                  <div className="space-y-2">
                    {items.map((item, idx) => (
                      <div key={idx} className="flex gap-2 items-center flex-wrap">
                        {item.isNew ? (
                          <input
                            type="text"
                            placeholder="신규 제품명 입력"
                            value={item.newProductName}
                            onChange={(e) => updateItemRow(idx, 'newProductName', e.target.value)}
                            className="flex-1 min-w-[140px] border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                        ) : (
                          <select
                            value={item.product_id}
                            onChange={(e) => updateItemRow(idx, 'product_id', e.target.value)}
                            className="flex-1 min-w-[140px] border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                          >
                            <option value="">제품 선택</option>
                            {products.map(p => (
                              <option key={p.id} value={p.id}>{p.product_name} ({p.product_code})</option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          onClick={() => updateItemRow(idx, 'isNew', !item.isNew)}
                          className={`text-xs px-2 py-1.5 rounded-lg border shrink-0 ${
                            item.isNew ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-500 hover:border-gray-300'
                          }`}
                        >
                          신규 제품
                        </button>
                        <input
                          type="number"
                          placeholder="수량"
                          min="1"
                          value={item.quantity || ''}
                          onChange={(e) => updateItemRow(idx, 'quantity', Number(e.target.value))}
                          className="w-24 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                        {formData.doc_type !== '출고지시서' && (
                          <input
                            type="number"
                            placeholder="단가(선택)"
                            min="0"
                            value={item.unit_price}
                            onChange={(e) => updateItemRow(idx, 'unit_price', e.target.value)}
                            className="w-28 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                          />
                        )}
                        {items.length > 1 && (
                          <button type="button" onClick={() => removeItemRow(idx)} className="text-gray-400 hover:text-red-500 px-2">✕</button>
                        )}
                      </div>
                    ))}
                  </div>
                  {formData.doc_type !== '출고지시서' && (
                    <p className="text-xs text-gray-400 mt-1">단가를 비우면 제품 기본원가를 사용합니다</p>
                  )}
                  <button type="button" onClick={addItemRow} className="text-sm text-blue-600 hover:underline mt-2">
                    + 품목 추가
                  </button>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">메모</label>
                  <input
                    type="text"
                    value={formData.memo}
                    onChange={(e) => setFormData({ ...formData, memo: e.target.value })}
                    className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition"
                >
                  {saving ? '기안 중...' : '기안 제출'}
                </button>
              </form>
            </div>
          )}

          <div className="bg-white rounded-lg shadow">
            <div className="p-3 md:p-6 border-b space-y-3">
              <div className="flex gap-1 flex-wrap">
                {DOC_TYPES.map(dt => (
                  <button
                    key={dt}
                    onClick={() => setDocTypeTab(dt)}
                    className={`px-3 py-1.5 text-sm rounded-lg font-medium transition ${
                      docTypeTab === dt ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {dt}
                  </button>
                ))}
              </div>
              <div className="flex gap-1 flex-wrap">
                {STATUS_TABS.map(s => (
                  <button
                    key={s}
                    onClick={() => setStatusTab(s)}
                    className={`px-3 py-1 text-xs rounded-full font-medium transition ${
                      statusTab === s
                        ? s === '대기' ? 'bg-orange-500 text-white' : s === '승인' ? 'bg-green-600 text-white' : 'bg-red-500 text-white'
                        : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                    }`}
                  >
                    {s} ({documents.filter(d => d.doc_type === docTypeTab && d.status === s).length})
                  </button>
                ))}
              </div>
            </div>

            <div className="p-3 md:p-6">
              {filteredDocs.length === 0 ? (
                <p className="text-gray-500 text-center py-8">해당 문서가 없습니다.</p>
              ) : (
                <div className="space-y-3">
                  {filteredDocs.map(doc => (
                    <div key={doc.id} className="border rounded-lg p-4">
                      <div className="flex justify-between items-start gap-3 flex-wrap">
                        <div>
                          <p className="text-sm text-gray-500">
                            <Link href={`/approvals/${doc.id}`} className="text-blue-600 hover:underline font-medium">
                              {doc.order_number || '문서 보기'}
                            </Link>
                            {doc.supplier_name && <span className="ml-2">{doc.supplier_name} ·</span>}{' '}
                            {doc.doc_type === '이동품의서'
                              ? `${doc.warehouses?.name} → ${doc.to_warehouse?.name}`
                              : doc.doc_type === '출고지시서'
                              ? `${doc.warehouses?.name}${doc.channel ? ` → ${doc.channel}` : ''}`
                              : doc.warehouses?.name}
                          </p>
                          <ul className="text-sm mt-1">
                            {doc.approval_document_items.map(item => {
                              const p = doc.status === '승인' ? progressMap[`${doc.id}::${item.product_id}`] : undefined
                              return (
                                <li key={item.id}>
                                  {item.products?.product_name} — {item.quantity.toLocaleString()}개
                                  {p && (
                                    <span className={`ml-2 text-xs ${p.remaining_qty > 0 ? 'text-orange-500' : 'text-green-600'}`}>
                                      ({docTypeTab === '발주품의서' ? '입고' : docTypeTab === '출고지시서' ? '출고' : '이동'} {p.actual_qty.toLocaleString()}/{p.approved_qty.toLocaleString()}
                                      {p.remaining_qty > 0 ? ` · 미달 ${p.remaining_qty.toLocaleString()}` : ' · 완료'})
                                    </span>
                                  )}
                                </li>
                              )
                            })}
                          </ul>
                          {doc.memo && <p className="text-xs text-gray-400 mt-1 whitespace-pre-line">{doc.memo}</p>}
                          <p className="text-xs text-gray-400 mt-1">
                            기안: {doc.requested_by || '-'} · {new Date(doc.created_at).toLocaleDateString('ko-KR')}
                            {doc.approved_by && ` · 처리: ${doc.approved_by}`}
                          </p>
                          {doc.approval_steps.length > 0 && (() => {
                            const sortedSteps = [...doc.approval_steps].sort((a, b) => a.step_order - b.step_order)
                            const approvedCount = sortedSteps.filter(s => s.status === '승인').length
                            return (
                              <p className="text-xs text-gray-400 mt-0.5">
                                결재선 {approvedCount}/{sortedSteps.length}
                                {sortedSteps.some(s => s.status === '반려') ? ' · 반려됨' : doc.status === '대기' ? ' · 대기중' : ''}
                              </p>
                            )
                          })()}
                        </div>
                        {isApprover && doc.status === '대기' && (
                          <Link
                            href={`/approvals/${doc.id}`}
                            className="text-xs bg-orange-100 text-orange-700 px-2.5 py-1.5 rounded-lg hover:bg-orange-200 transition shrink-0"
                          >
                            검토 후 승인 →
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
