'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/app/contexts/AuthContext'
import { supabase } from '@/lib/supabase'
import Navbar from '@/app/components/Navbar'
import {
  getInboundReconciliation,
  getOutboundReconciliation,
  getTransferReconciliation,
  getInboundEvidenceExceptions,
  getOutboundEvidenceExceptions,
  classifyMissing,
  ReconciliationProgressRow,
  UnmatchedRow,
  EvidenceExceptionRow,
  NonTransportRow
} from '@/lib/reconciliation'

type SourceLabel = '입고' | '출고' | '이동'
type EvidenceSourceLabel = '입고' | '출고'

interface LabeledMissing extends ReconciliationProgressRow {
  source: SourceLabel
}

interface LabeledUnmatched extends UnmatchedRow {
  source: SourceLabel
}

interface LabeledEvidence extends EvidenceExceptionRow {
  source: EvidenceSourceLabel
}

interface CompletedEvidenceRow {
  transaction_id: string
  product_name: string
  warehouse_name: string | null
  quantity: number
  evidence_file_url: string
  created_at: string
  source: EvidenceSourceLabel
}

const SHIPPING_TYPES = ['택배/화물', '자차배송', '직접픽업'] as const

export default function ExceptionsPage() {
  const { profile } = useAuth()
  const [missing, setMissing] = useState<LabeledMissing[]>([])
  const [unmatched, setUnmatched] = useState<LabeledUnmatched[]>([])
  const [evidenceExceptions, setEvidenceExceptions] = useState<LabeledEvidence[]>([])
  const [completedEvidence, setCompletedEvidence] = useState<CompletedEvidenceRow[]>([])
  const [nonTransport, setNonTransport] = useState<NonTransportRow[]>([])
  const [pendingMissing, setPendingMissing] = useState<LabeledMissing[]>([])
  const [awaitingConfirmation, setAwaitingConfirmation] = useState<LabeledMissing[]>([])
  const [graceDays, setGraceDays] = useState(3)
  const [outboundGraceDays, setOutboundGraceDays] = useState(0)
  const [loading, setLoading] = useState(true)

  const [attachingId, setAttachingId] = useState<string | null>(null)
  const [attachFile, setAttachFile] = useState<File | null>(null)
  const [attachQty, setAttachQty] = useState('')
  const [attachShippingType, setAttachShippingType] = useState<typeof SHIPPING_TYPES[number] | ''>('')
  const [attaching, setAttaching] = useState(false)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!profile?.company_id) return
    load(profile.company_id)
  }, [profile?.company_id])

  async function load(companyId: string) {
    setLoading(true)
    const [{ data: companyData }, inbound, outbound, transfer, inboundEvidence, outboundEvidence, { data: completedTx }] = await Promise.all([
      supabase.from('companies').select('reconciliation_grace_days, outbound_grace_days').eq('id', companyId).single(),
      getInboundReconciliation(companyId),
      getOutboundReconciliation(companyId),
      getTransferReconciliation(companyId),
      getInboundEvidenceExceptions(companyId),
      getOutboundEvidenceExceptions(companyId),
      supabase
        .from('transactions')
        .select('id, type, quantity, evidence_quantity, evidence_file_url, created_at, products(product_name), warehouses(name)')
        .eq('company_id', companyId)
        .in('type', ['입고', '출고'])
        .not('evidence_file_url', 'is', null)
        .order('created_at', { ascending: false })
    ])
    const grace = companyData?.reconciliation_grace_days ?? 3
    const outboundGrace = companyData?.outbound_grace_days ?? 0
    setGraceDays(grace)
    setOutboundGraceDays(outboundGrace)
    const graceBySource = { default: grace, outbound: outboundGrace }

    const allMissing: LabeledMissing[] = [
      ...inbound.progress.filter(p => p.remaining_qty > 0).map(p => ({ ...p, source: '입고' as SourceLabel })),
      ...outbound.progress.filter(p => p.remaining_qty > 0).map(p => ({ ...p, source: '출고' as SourceLabel })),
      ...transfer.progress.filter(p => p.remaining_qty > 0).map(p => ({ ...p, source: '이동' as SourceLabel }))
    ]
    setMissing(allMissing.filter(m => classifyMissing(m, graceBySource) === 'overdue'))
    setPendingMissing(allMissing.filter(m => classifyMissing(m, graceBySource) === 'pending'))
    setAwaitingConfirmation(allMissing.filter(m => classifyMissing(m, graceBySource) === 'awaiting'))

    setUnmatched([
      ...inbound.unmatched.map(u => ({ ...u, source: '입고' as SourceLabel })),
      ...outbound.unmatched.map(u => ({ ...u, source: '출고' as SourceLabel })),
      ...transfer.unmatched.map(u => ({ ...u, source: '이동' as SourceLabel }))
    ])

    setEvidenceExceptions([
      ...inboundEvidence.map(e => ({ ...e, source: '입고' as EvidenceSourceLabel })),
      ...outboundEvidence.exceptions.map(e => ({ ...e, source: '출고' as EvidenceSourceLabel }))
    ])
    setNonTransport(outboundEvidence.nonTransport)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setCompletedEvidence(
      (completedTx || [])
        .filter((t: any) => t.evidence_quantity === t.quantity)
        .map((t: any) => ({
          transaction_id: t.id,
          product_name: t.products?.product_name || '',
          warehouse_name: t.warehouses?.name || null,
          quantity: t.quantity,
          evidence_file_url: t.evidence_file_url,
          created_at: t.created_at,
          source: t.type as EvidenceSourceLabel
        }))
    )
    setLoading(false)
  }

  function openAttachForm(row: LabeledEvidence) {
    setAttachingId(row.transaction_id)
    setAttachFile(null)
    setAttachQty('')
    setAttachShippingType('')
  }

  async function handleAttachSubmit(row: LabeledEvidence) {
    if (!profile?.company_id) return

    // 출고 건에서 비운송(자차배송/직접픽업)으로 신고하는 경우: 파일/수량 없이 배송유형만 저장
    if (row.source === '출고' && (attachShippingType === '자차배송' || attachShippingType === '직접픽업')) {
      setAttaching(true)
      const { error } = await supabase.from('transactions')
        .update({ shipping_type: attachShippingType })
        .eq('id', row.transaction_id)
      setAttaching(false)
      if (error) { alert('저장 실패: ' + error.message); return }
      setAttachingId(null)
      load(profile.company_id)
      return
    }

    if (!attachFile || !attachQty || Number(attachQty) <= 0) {
      alert('파일과 수량을 입력해주세요.')
      return
    }

    setAttaching(true)
    try {
      const ext = attachFile.name.split('.').pop() || 'bin'
      const path = `${profile.company_id}/${row.transaction_id}-${Date.now()}.${ext}`
      const { error: uploadError } = await supabase.storage.from('evidence').upload(path, attachFile)
      if (uploadError) {
        alert('파일 업로드 실패: ' + uploadError.message)
        return
      }

      const updatePayload: Record<string, unknown> = {
        evidence_file_url: path,
        evidence_quantity: Number(attachQty)
      }
      if (row.source === '출고') updatePayload.shipping_type = '택배/화물'

      const { error: updateError } = await supabase.from('transactions')
        .update(updatePayload)
        .eq('id', row.transaction_id)

      if (updateError) {
        alert('저장 실패: ' + updateError.message)
        return
      }

      setAttachingId(null)
      load(profile.company_id)
    } finally {
      setAttaching(false)
    }
  }

  async function viewEvidence(transactionId: string, path: string) {
    if (signedUrls[transactionId]) {
      window.open(signedUrls[transactionId], '_blank')
      return
    }
    const { data, error } = await supabase.storage.from('evidence').createSignedUrl(path, 300)
    if (error || !data) {
      alert('파일 조회 실패: ' + error?.message)
      return
    }
    setSignedUrls(prev => ({ ...prev, [transactionId]: data.signedUrl }))
    window.open(data.signedUrl, '_blank')
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
        <div className="max-w-6xl mx-auto space-y-8">
          <div>
            <h1 className="text-xl font-bold text-gray-900">예외 리스트</h1>
            <p className="text-sm text-gray-500 mt-1">
              승인 증빙(품의서·지시서) 대비 실물 기록을 양방향으로 대조한 결과입니다.
            </p>
          </div>

          <div className="bg-white rounded-lg shadow">
            <div className="p-3 md:p-6 border-b">
              <h2 className="text-base md:text-lg font-semibold text-orange-600">
                🚨 기한 초과 미기록/미달 ({missing.length}건)
              </h2>
              <p className="text-xs text-gray-400 mt-1">
                거래처 확정 납기일 + 유예(입고/이동 {graceDays}일, 출고 {outboundGraceDays}일)을 넘겼는데도 실물 처리가 안 됐거나 부족한 건
              </p>
            </div>
            <div className="p-3 md:p-6">
              {missing.length === 0 ? (
                <p className="text-gray-500 text-center py-6">해당 사항 없습니다.</p>
              ) : (
                <div className="space-y-2">
                  {missing.map((m, i) => (
                    <div key={`${m.document_id}-${m.product_id}-${i}`} className="flex items-center justify-between border-b py-2">
                      <div>
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 mr-2">{m.source}</span>
                        <span className="font-medium text-sm">{m.product_name}</span>
                        <span className="text-xs text-gray-500 ml-2">{m.display_location}</span>
                        {m.escalated_at ? (
                          <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded ml-2">에스컬레이션됨</span>
                        ) : m.stage1_alert_sent_at ? (
                          <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded ml-2">1차 알림중</span>
                        ) : null}
                      </div>
                      <div className="text-right text-sm">
                        <span className="text-orange-600 font-semibold">미달 {m.remaining_qty.toLocaleString()}</span>
                        <span className="text-gray-400 text-xs ml-1">({m.actual_qty.toLocaleString()}/{m.approved_qty.toLocaleString()})</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {(pendingMissing.length > 0 || awaitingConfirmation.length > 0) && (
                <p className="text-xs text-gray-400 mt-4">
                  {pendingMissing.length > 0 && `진행중(확정 기한 내) ${pendingMissing.length}건`}
                  {pendingMissing.length > 0 && awaitingConfirmation.length > 0 && ' · '}
                  {awaitingConfirmation.length > 0 && `확정 대기 ${awaitingConfirmation.length}건 — 거래처 납기 확정 전이라 예외 아님`}
                </p>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow">
            <div className="p-3 md:p-6 border-b">
              <h2 className="text-base md:text-lg font-semibold text-red-600">
                🚨 기록 있음 · 증빙 없음 ({unmatched.length}건)
              </h2>
              <p className="text-xs text-gray-400 mt-1">
                승인문서 없이 처리됐거나 승인수량을 초과한 실물기록 (내부사용 반출은 주간요약으로 별도 관리)
              </p>
            </div>
            <div className="p-3 md:p-6">
              {unmatched.length === 0 ? (
                <p className="text-gray-500 text-center py-6">해당 사항 없습니다.</p>
              ) : (
                <div className="space-y-2">
                  {unmatched.map((u, i) => (
                    <div key={`${u.product_id}-${i}`} className="flex items-center justify-between border-b py-2">
                      <div>
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 mr-2">{u.source}</span>
                        <span className="font-medium text-sm">{u.product_name}</span>
                        <span className="text-xs text-gray-500 ml-2">{u.display_location}</span>
                      </div>
                      <div className="text-right text-sm">
                        <span className="text-red-600 font-semibold">{u.quantity.toLocaleString()}개</span>
                        <span className="text-gray-400 text-xs ml-1">({u.reason})</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow">
            <div className="p-3 md:p-6 border-b">
              <h2 className="text-base md:text-lg font-semibold text-purple-600">
                🧾 외부증빙(거래명세서·운송장) 미첨부/불일치 ({evidenceExceptions.length}건)
              </h2>
              <p className="text-xs text-gray-400 mt-1">
                제3자 발행 증빙(입고=거래명세서, 출고=운송장)이 없거나 수량이 실물기록과 다른 건
              </p>
            </div>
            <div className="p-3 md:p-6">
              {evidenceExceptions.length === 0 ? (
                <p className="text-gray-500 text-center py-6">해당 사항 없습니다.</p>
              ) : (
                <div className="space-y-2">
                  {evidenceExceptions.map((e) => (
                    <div key={e.transaction_id} className="border-b py-2">
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div>
                          <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 mr-2">{e.source}</span>
                          <span className="font-medium text-sm">{e.product_name}</span>
                          {e.warehouse_name && <span className="text-xs text-gray-500 ml-2">{e.warehouse_name}</span>}
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right text-sm">
                            <span className="text-purple-600 font-semibold">{e.quantity.toLocaleString()}개</span>
                            <span className="text-gray-400 text-xs ml-1">
                              ({e.reason}{e.reason === '증빙수량 불일치' ? ` · 증빙상 ${e.evidence_quantity?.toLocaleString()}개` : ''})
                            </span>
                          </div>
                          {e.evidence_file_url && (
                            <button
                              onClick={() => viewEvidence(e.transaction_id, e.evidence_file_url!)}
                              className="text-xs text-blue-600 hover:underline shrink-0"
                            >
                              보기
                            </button>
                          )}
                          <button
                            onClick={() => attachingId === e.transaction_id ? setAttachingId(null) : openAttachForm(e)}
                            className="text-xs bg-purple-600 text-white px-2.5 py-1 rounded-lg hover:bg-purple-700 transition shrink-0"
                          >
                            {attachingId === e.transaction_id ? '취소' : '증빙 첨부'}
                          </button>
                        </div>
                      </div>

                      {attachingId === e.transaction_id && (
                        <div className="mt-2 bg-gray-50 rounded-lg p-3 flex flex-wrap items-end gap-3">
                          {e.source === '출고' && (
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">배송유형</label>
                              <select
                                value={attachShippingType}
                                onChange={(ev) => setAttachShippingType(ev.target.value as typeof SHIPPING_TYPES[number])}
                                className="border rounded-lg px-2 py-1.5 text-sm"
                              >
                                <option value="">선택</option>
                                {SHIPPING_TYPES.map(st => (
                                  <option key={st} value={st}>{st}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          {(e.source === '입고' || attachShippingType === '택배/화물' || attachShippingType === '') && (
                            <>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">
                                  {e.source === '입고' ? '거래명세서 파일' : '운송장 파일'}
                                </label>
                                <input
                                  type="file"
                                  accept="image/*,application/pdf"
                                  onChange={(ev) => setAttachFile(ev.target.files?.[0] || null)}
                                  className="text-sm"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-gray-500 mb-1">증빙상 수량</label>
                                <input
                                  type="number"
                                  min="1"
                                  value={attachQty}
                                  onChange={(ev) => setAttachQty(ev.target.value)}
                                  className="w-24 border rounded-lg px-2 py-1.5 text-sm"
                                />
                              </div>
                            </>
                          )}
                          <button
                            onClick={() => handleAttachSubmit(e)}
                            disabled={attaching}
                            className="bg-green-600 text-white px-3 py-1.5 text-sm rounded-lg hover:bg-green-700 disabled:opacity-50 transition"
                          >
                            {attaching ? '저장 중...' : '저장'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {nonTransport.length > 0 && (
                <p className="text-xs text-gray-400 mt-4">
                  비운송 처리 {nonTransport.length}건 (자차배송/직접픽업, 운송장 불필요)
                </p>
              )}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow">
            <div className="p-3 md:p-6 border-b">
              <h2 className="text-base md:text-lg font-semibold text-green-600">
                ✅ 증빙 완료 ({completedEvidence.length}건)
              </h2>
              <p className="text-xs text-gray-400 mt-1">
                거래명세서·운송장이 첨부되고 수량까지 일치해 대사가 끝난 건입니다.
              </p>
            </div>
            <div className="p-3 md:p-6">
              {completedEvidence.length === 0 ? (
                <p className="text-gray-500 text-center py-6">해당 사항 없습니다.</p>
              ) : (
                <div className="space-y-2">
                  {completedEvidence.map((c) => (
                    <div key={c.transaction_id} className="flex items-center justify-between border-b py-2">
                      <div>
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 mr-2">{c.source}</span>
                        <span className="font-medium text-sm">{c.product_name}</span>
                        {c.warehouse_name && <span className="text-xs text-gray-500 ml-2">{c.warehouse_name}</span>}
                        <span className="text-xs text-gray-400 ml-2">{new Date(c.created_at).toLocaleDateString('ko-KR')}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-green-700 font-semibold text-sm">{c.quantity.toLocaleString()}개</span>
                        <button
                          onClick={() => viewEvidence(c.transaction_id, c.evidence_file_url)}
                          className="text-xs text-blue-600 hover:underline shrink-0"
                        >
                          보기
                        </button>
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
