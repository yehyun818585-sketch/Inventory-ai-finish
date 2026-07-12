import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function extractConfirmedDate(text: string): string | null {
  const match = text.match(/(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})/)
  if (!match) return null
  const [, y, m, d] = match
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}

// pdf-parse(정확히는 내부적으로 쓰는 pdfjs-dist)가 모듈 로딩 시점에 브라우저 전용 DOMMatrix를
// 무조건 참조해서, Node 서버리스 환경에선 폴리필 없이는 아예 텍스트 추출이 안 됨 (에러가 조용히
// 삼켜져서 "스캔본이라 텍스트 없음"과 구분이 안 됐던 원인). import 전에 전역으로 채워준다.
let workerConfigured = false
async function ensurePdfParseRuntime(): Promise<void> {
  if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
    const { default: DOMMatrixPolyfill } = await import('dommatrix')
    ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = DOMMatrixPolyfill
  }
  // pdfjs-dist는 실행 시점에 별도 워커 파일(pdf.worker.mjs)을 동적으로 찾는데, Vercel 서버리스
  // 번들의 파일 트레이싱이 그 경로를 못 잡아서 "Setting up fake worker failed"로 죽는다.
  // pdf-parse가 워커 코드를 통째로 data URL 문자열로 내장해서 제공해주는 걸(getData) 그대로
  // workerSrc로 지정하면 파일시스템에 전혀 의존하지 않고 끝난다.
  if (!workerConfigured) {
    const { getData } = await import('pdf-parse/worker')
    const { PDFParse } = await import('pdf-parse')
    PDFParse.setWorker(getData())
    workerConfigured = true
  }
}

// PDF(텍스트 기반)에서 본문 텍스트 추출. 스캔본 등 텍스트가 없으면 null.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extractPdfText(buffer: Buffer): Promise<{ text: string | null; error: string | null }> {
  try {
    await ensurePdfParseRuntime()
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    await parser.destroy()
    const text = (result.text || '').trim()
    return { text: text.length > 0 ? text : null, error: null }
  } catch (err) {
    return { text: null, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
  }
}

// 공백 차이(데일리쿠션 vs 데일리 쿠션)는 다른 문서라는 신호가 아니므로 비교 전에 제거.
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, '')
}

// 이메일 제목으로 찾은 문서와, 실제 첨부파일 내용이 정말 그 문서 얘기가 맞는지 확인.
// 1) 발주번호가 명시돼 있으면 그것부터 확인(다르면 바로 실패).
// 2) 없으면 품목코드(우리가 발주 메일에 이미 알려준 값이라 신뢰도가 높음)+수량이 함께 나오는지 확인.
// 3) 그것도 없으면 품목명+수량이 함께 나오는지로 본다.
// 식별자·수량 중 하나만 우연히 일치하는 건 그 문서라는 근거로 보기엔 약하기 때문에 항상 함께 확인한다.
function verifyAttachmentContent(
  text: string,
  expectedOrderNumber: string,
  items: { product_name: string; product_code: string; quantity: number }[]
): { verified: boolean; reason: string | null } {
  // PDF 텍스트 추출 시 표 셀 경계 등에서 줄바꿈/공백이 끼어 "PO-260710-\n01"처럼 끊기는 경우가 있어,
  // 정규식 적용 전에 공백을 먼저 제거한다 (안 그러면 발주번호가 버젓이 있어도 정규식이 못 찾아서
  // 이 1차 검증을 건너뛰고 더 약한 폴백 검증으로 새버리는 문제가 생김).
  const normalizedText = normalizeForMatch(text)
  const poMatch = normalizedText.match(/PO-\d{6}-\d{2}/)
  if (poMatch) {
    if (poMatch[0] === expectedOrderNumber) return { verified: true, reason: null }
    return { verified: false, reason: `이메일 제목(${expectedOrderNumber})과 첨부파일 안 발주번호(${poMatch[0]})가 다릅니다.` }
  }

  const matched = items.some(i => {
    const qtyFound = normalizedText.includes(String(i.quantity))
    if (!qtyFound) return false
    const codeFound = !!i.product_code && normalizedText.includes(normalizeForMatch(i.product_code))
    const nameFound = !!i.product_name && normalizedText.includes(normalizeForMatch(i.product_name))
    return codeFound || nameFound
  })
  if (matched) return { verified: true, reason: null }

  return { verified: false, reason: '첨부파일에서 발주 내역(품목코드/품목명+수량)과 일치하는 정보를 찾을 수 없습니다.' }
}

interface InboundPayload {
  order_number: string
  text?: string
  attachment?: { filename: string; contentType: string; contentBase64: string } | null
}

export async function POST(request: Request) {
  const secret = request.headers.get('x-webhook-secret')
  if (!secret || secret !== process.env.INBOUND_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: false, reason: 'unauthorized' }, { status: 401 })
  }

  const body: InboundPayload = await request.json()
  const { order_number, text, attachment } = body

  if (!order_number) {
    return NextResponse.json({ ok: false, reason: 'order_number가 없습니다.' }, { status: 400 })
  }

  const supabase = getSupabaseAdmin()

  const { data: doc, error: docError } = await supabase
    .from('approval_documents')
    .select(`
      id, company_id, status, requested_by_user_id, order_number,
      approval_document_items ( quantity, products ( product_name, product_code ) )
    `)
    .eq('order_number', order_number)
    .eq('doc_type', '발주품의서')
    .single()

  if (docError || !doc) {
    return NextResponse.json({ ok: false, reason: `발주번호 ${order_number} 문서를 찾을 수 없습니다.` }, { status: 404 })
  }

  let filePath: string | null = null
  let heldReason: string | null = null
  // 디버깅용 — 검증이 어느 단계에서 왜 통과/보류됐는지 Worker 로그(응답 body)로 바로 보기 위함.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const debug: Record<string, any> = {}

  if (attachment?.contentBase64) {
    const buffer = Buffer.from(attachment.contentBase64, 'base64')
    const isPdf = attachment.contentType === 'application/pdf' || attachment.filename.toLowerCase().endsWith('.pdf')
    debug.isPdf = isPdf

    if (isPdf) {
      const { text: pdfText, error: extractError } = await extractPdfText(buffer)
      debug.textExtracted = !!pdfText
      debug.textLength = pdfText?.length ?? 0
      debug.textPreview = pdfText ? pdfText.slice(0, 200) : null
      debug.extractError = extractError
      if (pdfText) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = ((doc.approval_document_items || []) as any[]).map(i => ({
          product_name: i.products?.product_name || '',
          product_code: i.products?.product_code || '',
          quantity: i.quantity
        }))
        debug.items = items
        const { verified, reason } = verifyAttachmentContent(pdfText, order_number, items)
        debug.verified = verified
        if (!verified) heldReason = reason
      }
      // 텍스트 추출 자체가 안 되면(스캔본 등) 검증 불가 — 그냥 통과시킨다.
    }

    if (!heldReason) {
      const ext = attachment.filename.split('.').pop() || 'bin'
      const candidatePath = `${doc.company_id}/po-confirm/${doc.id}-auto-${Date.now()}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from('evidence')
        .upload(candidatePath, buffer, { contentType: attachment.contentType || 'application/octet-stream' })
      if (uploadError) {
        console.error('발주확인서 첨부파일 업로드 실패:', uploadError)
      } else {
        filePath = candidatePath
      }
    }
  }

  const confirmedDate = heldReason ? null : extractConfirmedDate(text || '')

  if (heldReason) {
    // 알림만 보내면 안 읽고 지나쳤을 때 그대로 묻히므로, 문서 자체에도 "확인 필요" 상태를 남겨
    // 상세페이지에서 빨간 배너로 보이게 한다.
    const { error: flagError } = await supabase
      .from('approval_documents')
      .update({ po_confirmation_review_needed: true, po_confirmation_review_reason: heldReason })
      .eq('id', doc.id)
    if (flagError) console.error('발주확인서 검토필요 플래그 저장 실패:', flagError)
  } else {
    const update: Record<string, string | boolean> = { po_confirmation_review_needed: false }
    if (filePath) update.confirmation_file_url = filePath
    if (confirmedDate) update.confirmed_date = confirmedDate

    const { error: updateError } = await supabase
      .from('approval_documents')
      .update(update)
      .eq('id', doc.id)
    if (updateError) console.error('발주확인서 자동 반영 실패:', updateError)
  }

  if (doc.requested_by_user_id) {
    const message = heldReason
      ? `발주확인서 메일이 접수됐지만 검토가 필요합니다 (${order_number}) · ${heldReason}`
      : `발주확인서 메일이 자동으로 접수되었습니다 (${order_number})${confirmedDate ? ` · 납기 ${confirmedDate}` : ''}`

    const { error: notifyError } = await supabase.from('notifications').insert([{
      company_id: doc.company_id,
      recipient_user_id: doc.requested_by_user_id,
      document_id: doc.id,
      type: '발주확인',
      message
    }])
    if (notifyError) console.error('발주확인 알림 발송 실패:', notifyError)
  }

  return NextResponse.json({
    ok: true,
    document_id: doc.id,
    confirmed_date: confirmedDate,
    file: filePath,
    held: !!heldReason,
    held_reason: heldReason,
    debug
  })
}
