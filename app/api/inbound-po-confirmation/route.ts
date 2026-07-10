import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { PDFParse } from 'pdf-parse'

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

// PDF(텍스트 기반)에서 본문 텍스트 추출. 스캔본 등 텍스트가 없으면 null.
async function extractPdfText(buffer: Buffer): Promise<string | null> {
  try {
    const parser = new PDFParse({ data: buffer })
    const result = await parser.getText()
    await parser.destroy()
    const text = (result.text || '').trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

// 이메일 제목으로 찾은 문서와, 실제 첨부파일 내용이 정말 그 문서 얘기가 맞는지 단계별로 확인.
// 발주번호 → 품목명 → 수량 순서로 내려가며 확인하고, 명백히 다른 발주번호가 적혀있으면 바로 실패 처리.
function verifyAttachmentContent(
  text: string,
  expectedOrderNumber: string,
  items: { product_name: string; quantity: number }[]
): { verified: boolean; reason: string | null } {
  const poMatch = text.match(/PO-\d{6}-\d{2}/)
  if (poMatch) {
    if (poMatch[0] === expectedOrderNumber) return { verified: true, reason: null }
    return { verified: false, reason: `이메일 제목(${expectedOrderNumber})과 첨부파일 안 발주번호(${poMatch[0]})가 다릅니다.` }
  }

  const nameMatch = items.some(i => i.product_name && text.includes(i.product_name))
  if (nameMatch) return { verified: true, reason: null }

  const qtyMatch = items.some(i => text.includes(String(i.quantity)))
  if (qtyMatch) return { verified: true, reason: null }

  return { verified: false, reason: '첨부파일에서 발주 내역과 일치하는 정보(발주번호·품목명·수량)를 찾을 수 없습니다.' }
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
      approval_document_items ( quantity, products ( product_name ) )
    `)
    .eq('order_number', order_number)
    .eq('doc_type', '발주품의서')
    .single()

  if (docError || !doc) {
    return NextResponse.json({ ok: false, reason: `발주번호 ${order_number} 문서를 찾을 수 없습니다.` }, { status: 404 })
  }

  let filePath: string | null = null
  let heldReason: string | null = null

  if (attachment?.contentBase64) {
    const buffer = Buffer.from(attachment.contentBase64, 'base64')
    const isPdf = attachment.contentType === 'application/pdf' || attachment.filename.toLowerCase().endsWith('.pdf')

    if (isPdf) {
      const pdfText = await extractPdfText(buffer)
      if (pdfText) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items = ((doc.approval_document_items || []) as any[]).map(i => ({
          product_name: i.products?.product_name || '',
          quantity: i.quantity
        }))
        const { verified, reason } = verifyAttachmentContent(pdfText, order_number, items)
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

  if (!heldReason) {
    const update: Record<string, string> = {}
    if (filePath) update.confirmation_file_url = filePath
    if (confirmedDate) update.confirmed_date = confirmedDate

    if (Object.keys(update).length > 0) {
      const { error: updateError } = await supabase
        .from('approval_documents')
        .update(update)
        .eq('id', doc.id)
      if (updateError) console.error('발주확인서 자동 반영 실패:', updateError)
    }
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
    held_reason: heldReason
  })
}
