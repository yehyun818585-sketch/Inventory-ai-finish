'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'

type DocType = '발주품의서' | '출고지시서' | '이동품의서'
type Status = '대기' | '승인' | '반려'

interface DocItem {
  id: string
  product_id: string
  quantity: number
  unit_price: number | null
  products: { product_name: string; product_code: string } | null
}

interface ApprovalStep {
  id: string
  step_order: number
  status: Status
  acted_by_name: string | null
  acted_at: string | null
}

interface DocumentDetail {
  id: string
  doc_type: DocType
  status: Status
  warehouse_id: string | null
  to_warehouse_id: string | null
  channel: string | null
  memo: string | null
  expected_date: string | null
  confirmed_date: string | null
  confirmation_file_url: string | null
  supplier_name: string | null
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

export default function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { profile } = useAuth()
  const [doc, setDoc] = useState<DocumentDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [showEvidence, setShowEvidence] = useState(false)
  const [signedUrl, setSignedUrl] = useState<string | null>(null)

  const [showConfirmForm, setShowConfirmForm] = useState(false)
  const [confirmedDate, setConfirmedDate] = useState('')
  const [confirmFile, setConfirmFile] = useState<File | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!id) return
    load()
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('approval_documents')
      .select(`
        id, doc_type, status, warehouse_id, to_warehouse_id, channel, memo,
        expected_date, confirmed_date, confirmation_file_url, supplier_name, order_number,
        requested_by, requested_by_user_id, approved_by, approved_at, created_at,
        warehouses:warehouse_id (name),
        to_warehouse:to_warehouse_id (name),
        approval_document_items ( id, product_id, quantity, unit_price, products (product_name, product_code) ),
        approval_steps ( id, step_order, status, acted_by_name, acted_at )
      `)
      .eq('id', id)
      .single()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setDoc((data as any) || null)
    setLoading(false)
  }

  async function viewEvidence() {
    if (!doc?.confirmation_file_url) return
    if (signedUrl) {
      window.open(signedUrl, '_blank')
      return
    }
    const { data, error } = await supabase.storage.from('evidence').createSignedUrl(doc.confirmation_file_url, 300)
    if (error || !data) {
      alert('파일 조회 실패: ' + error?.message)
      return
    }
    setSignedUrl(data.signedUrl)
    window.open(data.signedUrl, '_blank')
  }

  async function handleConfirmSubmit() {
    if (!doc || !confirmedDate) {
      alert('확정 납기일을 입력해주세요.')
      return
    }
    setConfirming(true)
    try {
      let filePath: string | null = doc.confirmation_file_url
      if (confirmFile) {
        const ext = confirmFile.name.split('.').pop() || 'bin'
        filePath = `${profile?.company_id}/po-confirm/${doc.id}-${Date.now()}.${ext}`
        const { error: uploadError } = await supabase.storage.from('evidence').upload(filePath, confirmFile)
        if (uploadError) {
          alert('파일 업로드 실패: ' + uploadError.message)
          return
        }
      }

      const { error } = await supabase.from('approval_documents').update({
        confirmed_date: confirmedDate,
        confirmation_file_url: filePath
      }).eq('id', doc.id)

      if (error) {
        alert('저장 실패: ' + error.message)
        return
      }
      setShowConfirmForm(false)
      load()
    } finally {
      setConfirming(false)
    }
  }

  const isApprover = profile?.position === '관리책임자' || profile?.position === '대표'

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-xl">로딩 중...</p>
      </div>
    )
  }

  if (!doc) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen bg-slate-50 pt-28 md:pt-20 p-4 md:p-8 text-center text-gray-500">
          문서를 찾을 수 없습니다.
        </div>
      </>
    )
  }

  const sortedSteps = [...doc.approval_steps].sort((a, b) => a.step_order - b.step_order)
  const destination = doc.doc_type === '이동품의서'
    ? `${doc.warehouses?.name || ''} → ${doc.to_warehouse?.name || ''}`
    : doc.doc_type === '출고지시서'
    ? `${doc.warehouses?.name || ''}${doc.channel ? ` → ${doc.channel}` : ''}`
    : doc.warehouses?.name || ''

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-slate-50 pt-28 md:pt-20 p-4 md:p-8">
        <div className="max-w-3xl mx-auto">
          <button onClick={() => router.push('/approvals')} className="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block">
            ← 목록으로
          </button>

          <div className="bg-white rounded-lg shadow overflow-hidden">
            {/* 문서 헤더 */}
            <div className="bg-blue-900 text-white px-6 py-4 flex justify-between items-center">
              <h1 className="text-lg font-bold">{doc.doc_type}</h1>
              {doc.order_number && <span className="text-sm text-blue-200">발주번호 {doc.order_number}</span>}
            </div>

            <div className="p-6 space-y-6">
              {/* 문서 정보 */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm border rounded-lg overflow-hidden">
                <div className="bg-gray-50 px-3 py-2 font-medium text-gray-500">작성자</div>
                <div className="px-3 py-2">{doc.requested_by || '-'}</div>
                <div className="bg-gray-50 px-3 py-2 font-medium text-gray-500">작성일자</div>
                <div className="px-3 py-2">{new Date(doc.created_at).toLocaleDateString('ko-KR')}</div>

                {doc.supplier_name && (
                  <>
                    <div className="bg-gray-50 px-3 py-2 font-medium text-gray-500">거래처</div>
                    <div className="px-3 py-2">{doc.supplier_name}</div>
                  </>
                )}
                <div className="bg-gray-50 px-3 py-2 font-medium text-gray-500">
                  {doc.doc_type === '이동품의서' ? '이동 경로' : '납품/출고 장소'}
                </div>
                <div className="px-3 py-2">{destination}</div>

                {doc.doc_type !== '이동품의서' && (
                  <>
                    <div className="bg-gray-50 px-3 py-2 font-medium text-gray-500">희망일(요청)</div>
                    <div className="px-3 py-2">{doc.expected_date || '-'}</div>
                    <div className="bg-gray-50 px-3 py-2 font-medium text-gray-500">확정일</div>
                    <div className="px-3 py-2">
                      {doc.confirmed_date || <span className="text-orange-500">미확정</span>}
                    </div>
                  </>
                )}
              </div>

              {/* 결재란 */}
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">결재</p>
                <div className="flex gap-2 flex-wrap">
                  {sortedSteps.length === 0 ? (
                    <span className="text-sm text-gray-400">결재선 없음</span>
                  ) : sortedSteps.map(s => (
                    <div key={s.id} className="border rounded-lg px-3 py-2 text-center min-w-[100px]">
                      <p className="text-xs text-gray-400">{s.step_order}차 결재</p>
                      <p className={`text-sm font-medium ${s.status === '승인' ? 'text-green-600' : s.status === '반려' ? 'text-red-600' : 'text-orange-500'}`}>
                        {s.status}
                      </p>
                      {s.acted_by_name && <p className="text-xs text-gray-400">{s.acted_by_name}</p>}
                    </div>
                  ))}
                </div>
              </div>

              {/* 품목 표 */}
              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">품목</p>
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-gray-500">
                      <th className="border px-3 py-2 text-left">번호</th>
                      <th className="border px-3 py-2 text-left">품명</th>
                      <th className="border px-3 py-2 text-right">수량</th>
                      <th className="border px-3 py-2 text-right">단가</th>
                      <th className="border px-3 py-2 text-right">금액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.approval_document_items.map((item, i) => (
                      <tr key={item.id}>
                        <td className="border px-3 py-2">{i + 1}</td>
                        <td className="border px-3 py-2">{item.products?.product_name} <span className="text-gray-400">({item.products?.product_code})</span></td>
                        <td className="border px-3 py-2 text-right">{item.quantity.toLocaleString()}</td>
                        <td className="border px-3 py-2 text-right">{item.unit_price != null ? item.unit_price.toLocaleString() : '-'}</td>
                        <td className="border px-3 py-2 text-right">{item.unit_price != null ? (item.unit_price * item.quantity).toLocaleString() : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {doc.memo && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-1">특이사항</p>
                  <p className="text-sm text-gray-600 whitespace-pre-line">{doc.memo}</p>
                </div>
              )}

              {/* 증빙: hover 시 아이콘, 클릭 시 펼침 */}
              <div className="group relative border-t pt-4">
                <button
                  onClick={() => setShowEvidence(!showEvidence)}
                  className="text-sm text-gray-400 group-hover:text-gray-600 flex items-center gap-1.5 transition"
                >
                  <span className="opacity-0 group-hover:opacity-100 transition">📎</span>
                  증빙 {showEvidence ? '숨기기' : '보기'}
                </button>
                {showEvidence && (
                  <div className="mt-2 text-sm">
                    {doc.confirmation_file_url ? (
                      <button onClick={viewEvidence} className="text-blue-600 hover:underline">발주확인서 보기</button>
                    ) : (
                      <p className="text-gray-400">첨부된 발주확인서가 없습니다.</p>
                    )}
                  </div>
                )}
              </div>

              {/* 납기 확정 (승인권자만) */}
              {isApprover && doc.doc_type !== '이동품의서' && (
                <div className="border-t pt-4">
                  {!showConfirmForm ? (
                    <button
                      onClick={() => { setShowConfirmForm(true); setConfirmedDate(doc.confirmed_date || '') }}
                      className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition"
                    >
                      {doc.confirmed_date ? '납기 재확정' : '납기 확정'}
                    </button>
                  ) : (
                    <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">거래처 확정 납기일 *</label>
                        <input
                          type="date"
                          value={confirmedDate}
                          onChange={(e) => setConfirmedDate(e.target.value)}
                          className="border rounded-lg px-3 py-1.5 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">발주확인서 파일 (선택)</label>
                        <input
                          type="file"
                          accept="image/*,application/pdf"
                          onChange={(e) => setConfirmFile(e.target.files?.[0] || null)}
                          className="text-sm"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={handleConfirmSubmit}
                          disabled={confirming}
                          className="bg-green-600 text-white px-3 py-1.5 text-sm rounded-lg hover:bg-green-700 disabled:opacity-50 transition"
                        >
                          {confirming ? '저장 중...' : '저장'}
                        </button>
                        <button
                          onClick={() => setShowConfirmForm(false)}
                          className="text-sm text-gray-500 px-3 py-1.5"
                        >
                          취소
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
