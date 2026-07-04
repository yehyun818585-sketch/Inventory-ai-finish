'use client'

import { useEffect, useState } from 'react'
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
}

const DOC_TYPES: DocType[] = ['발주품의서', '출고지시서', '이동품의서']
const STATUS_TABS: Status[] = ['대기', '승인', '반려']

export default function ApprovalsPage() {
  const { profile } = useAuth()
  const [products, setProducts] = useState<Product[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
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
    expected_date: ''
  })
  const [items, setItems] = useState<ItemRow[]>([{ product_id: '', quantity: 0 }])
  const [saving, setSaving] = useState(false)
  const [progressMap, setProgressMap] = useState<Record<string, ReconciliationProgressRow>>({})

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

    const { data: documentsData } = await supabase
      .from('approval_documents')
      .select(`
        id, doc_type, status, warehouse_id, to_warehouse_id, channel, memo, expected_date,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setDocuments((documentsData as any) || [])
    setLoading(false)
  }

  function addItemRow() {
    setItems([...items, { product_id: '', quantity: 0 }])
  }

  function updateItemRow(idx: number, field: keyof ItemRow, value: string | number) {
    const updated = [...items]
    updated[idx] = { ...updated[idx], [field]: value }
    setItems(updated)
  }

  function removeItemRow(idx: number) {
    setItems(items.filter((_, i) => i !== idx))
  }

  function resetForm() {
    setFormData({ doc_type: '발주품의서', warehouse_id: '', to_warehouse_id: '', channel: '', memo: '', expected_date: '' })
    setItems([{ product_id: '', quantity: 0 }])
    setShowForm(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const validItems = items.filter(i => i.product_id && i.quantity > 0)
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
    if ((formData.doc_type === '발주품의서' || formData.doc_type === '출고지시서') && !formData.expected_date) {
      alert(formData.doc_type === '발주품의서' ? '납기예정일을 입력해주세요.' : '출고예정일을 입력해주세요.')
      return
    }

    setSaving(true)
    try {
      const { data: doc, error: docError } = await supabase
        .from('approval_documents')
        .insert([{
          company_id: profile?.company_id,
          doc_type: formData.doc_type,
          status: '대기',
          warehouse_id: formData.warehouse_id,
          to_warehouse_id: formData.doc_type === '이동품의서' ? formData.to_warehouse_id : null,
          channel: formData.doc_type === '출고지시서' ? (formData.channel || null) : null,
          memo: formData.memo || null,
          expected_date: formData.doc_type !== '이동품의서' ? formData.expected_date : null,
          requested_by: profile?.name || null,
          requested_by_user_id: profile?.id || null
        }])
        .select('id')
        .single()

      if (docError || !doc) {
        alert('기안 실패: ' + docError?.message)
        return
      }

      const { error: itemsError } = await supabase
        .from('approval_document_items')
        .insert(validItems.map(i => ({
          document_id: doc.id,
          product_id: i.product_id,
          quantity: i.quantity
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

      alert('기안이 등록되었습니다. 승인 대기 중입니다.')
      resetForm()
      fetchData()
    } finally {
      setSaving(false)
    }
  }

  function currentPendingStep(doc: ApprovalDocument): ApprovalStep | undefined {
    return [...doc.approval_steps].sort((a, b) => a.step_order - b.step_order).find(s => s.status === '대기')
  }

  async function handleApprove(doc: ApprovalDocument) {
    const step = currentPendingStep(doc)
    if (!step) return
    if (!confirm(`${doc.doc_type} 승인하시겠습니까?`)) return

    const now = new Date().toISOString()
    await supabase.from('approval_steps').update({
      status: '승인',
      acted_by_user_id: profile?.id || null,
      acted_by_name: profile?.name || null,
      acted_at: now
    }).eq('id', step.id)

    // 결재선의 모든 단계가 승인됐는지 확인 (지금은 항상 1단계라 즉시 전체 승인)
    const otherSteps = doc.approval_steps.filter(s => s.id !== step.id)
    const allApproved = otherSteps.every(s => s.status === '승인')
    if (allApproved) {
      await supabase.from('approval_documents').update({
        status: '승인',
        approved_by: profile?.name || null,
        approved_at: now
      }).eq('id', doc.id)
    }
    fetchData()
  }

  async function handleReject(doc: ApprovalDocument) {
    const step = currentPendingStep(doc)
    if (!step) return
    const reason = prompt('반려 사유를 입력해주세요.')
    if (reason === null) return

    const now = new Date().toISOString()
    await supabase.from('approval_steps').update({
      status: '반려',
      acted_by_user_id: profile?.id || null,
      acted_by_name: profile?.name || null,
      acted_at: now
    }).eq('id', step.id)

    // 한 단계라도 반려되면 결재선이 몇 단계든 문서 전체를 즉시 반려 처리
    await supabase.from('approval_documents').update({
      status: '반려',
      approved_by: profile?.name || null,
      approved_at: now,
      memo: doc.memo ? `${doc.memo}\n[반려사유] ${reason}` : `[반려사유] ${reason}`
    }).eq('id', doc.id)
    fetchData()
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
                          onChange={() => setFormData({ ...formData, doc_type: dt, to_warehouse_id: '', channel: '' })}
                          className="mr-2"
                        />
                        <span className="font-medium">{dt}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                        placeholder="예: 올리브영, 쿠팡"
                        value={formData.channel}
                        onChange={(e) => setFormData({ ...formData, channel: e.target.value })}
                        className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  )}

                  {(formData.doc_type === '발주품의서' || formData.doc_type === '출고지시서') && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {formData.doc_type === '발주품의서' ? '납기예정일 *' : '출고예정일 *'}
                      </label>
                      <input
                        type="date"
                        required
                        value={formData.expected_date}
                        onChange={(e) => setFormData({ ...formData, expected_date: e.target.value })}
                        className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <p className="text-xs text-gray-400 mt-1">이 날짜 + 유예기간이 지나도 실물기록이 없으면 미기록으로 적발됩니다</p>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">품목 *</label>
                  <div className="space-y-2">
                    {items.map((item, idx) => (
                      <div key={idx} className="flex gap-2 items-center">
                        <select
                          value={item.product_id}
                          onChange={(e) => updateItemRow(idx, 'product_id', e.target.value)}
                          className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        >
                          <option value="">제품 선택</option>
                          {products.map(p => (
                            <option key={p.id} value={p.id}>{p.product_name} ({p.product_code})</option>
                          ))}
                        </select>
                        <input
                          type="number"
                          placeholder="수량"
                          min="1"
                          value={item.quantity || ''}
                          onChange={(e) => updateItemRow(idx, 'quantity', Number(e.target.value))}
                          className="w-28 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                        {items.length > 1 && (
                          <button type="button" onClick={() => removeItemRow(idx)} className="text-gray-400 hover:text-red-500 px-2">✕</button>
                        )}
                      </div>
                    ))}
                  </div>
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
                        {(() => {
                          if (!isApprover || doc.status !== '대기') return null
                          const isSelfDrafted = !!doc.requested_by_user_id && doc.requested_by_user_id === profile?.id
                          return (
                            <div className="flex flex-col items-end gap-1 shrink-0">
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleApprove(doc)}
                                  disabled={isSelfDrafted}
                                  className="bg-green-600 text-white px-3 py-1.5 text-sm rounded-lg hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                                >
                                  승인
                                </button>
                                <button
                                  onClick={() => handleReject(doc)}
                                  disabled={isSelfDrafted}
                                  className="bg-red-500 text-white px-3 py-1.5 text-sm rounded-lg hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition"
                                >
                                  반려
                                </button>
                              </div>
                              {isSelfDrafted && (
                                <p className="text-xs text-gray-400">본인이 기안한 건은 승인할 수 없습니다</p>
                              )}
                            </div>
                          )
                        })()}
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
