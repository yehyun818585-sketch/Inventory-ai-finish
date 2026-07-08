import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: Request) {
  try {
    const { document_id, recipient_email } = await request.json()
    if (!document_id || !recipient_email) {
      return NextResponse.json({ sent: false, reason: 'document_id와 recipient_email이 필요합니다.' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    const { data: doc, error: docError } = await supabase
      .from('approval_documents')
      .select(`
        id, doc_type, status, supplier_name, order_number, expected_date, created_at, company_id,
        warehouses:warehouse_id ( name ),
        approval_document_items ( quantity, unit_price, products ( product_name, product_code ) )
      `)
      .eq('id', document_id)
      .single()

    if (docError || !doc) {
      return NextResponse.json({ sent: false, reason: '문서를 찾을 수 없습니다.' }, { status: 404 })
    }
    if (doc.doc_type !== '발주품의서') {
      return NextResponse.json({ sent: false, reason: '발주품의서만 발송할 수 있습니다.' }, { status: 400 })
    }
    if (doc.status !== '승인') {
      return NextResponse.json({ sent: false, reason: '승인된 문서만 발송할 수 있습니다.' }, { status: 400 })
    }

    const { data: companyData } = await supabase
      .from('companies')
      .select('name')
      .eq('id', doc.company_id)
      .single()
    const companyName = companyData?.name || '발주사'

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (doc.approval_document_items || []) as any[]
    const itemRows = items.map((item, i) => `
      <tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:10px 8px;">${i + 1}</td>
        <td style="padding:10px 8px;">${item.products?.product_name || ''} <span style="color:#999;">(${item.products?.product_code || ''})</span></td>
        <td style="padding:10px 8px;text-align:right;">${item.quantity.toLocaleString()}</td>
        <td style="padding:10px 8px;text-align:right;">${item.unit_price != null ? item.unit_price.toLocaleString() : '-'}</td>
        <td style="padding:10px 8px;text-align:right;">${item.unit_price != null ? (item.unit_price * item.quantity).toLocaleString() : '-'}</td>
      </tr>`).join('')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warehouseName = (doc as any).warehouses?.name || ''

    const html = `
      <div style="font-family:-apple-system,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#1e3a8a;padding:24px 32px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;">
          <h1 style="margin:0;color:white;font-size:20px;">발주서</h1>
          <span style="color:#bfdbfe;font-size:13px;">${doc.order_number || ''}</span>
        </div>
        <div style="background:white;padding:28px 32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
          <table style="width:100%;font-size:14px;margin-bottom:20px;border-collapse:collapse;">
            <tr>
              <td style="padding:6px 0;color:#888;width:120px;">발주일자</td>
              <td style="padding:6px 0;">${new Date(doc.created_at).toLocaleDateString('ko-KR')}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#888;">발주사</td>
              <td style="padding:6px 0;">${companyName}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#888;">거래처</td>
              <td style="padding:6px 0;">${doc.supplier_name || ''}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#888;">납품 장소</td>
              <td style="padding:6px 0;">${warehouseName}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#888;">희망 납기일</td>
              <td style="padding:6px 0;">${doc.expected_date || '-'}</td>
            </tr>
          </table>

          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#f8f9fa;color:#888;">
                <th style="padding:8px;text-align:left;">번호</th>
                <th style="padding:8px;text-align:left;">품명</th>
                <th style="padding:8px;text-align:right;">수량</th>
                <th style="padding:8px;text-align:right;">단가</th>
                <th style="padding:8px;text-align:right;">금액</th>
              </tr>
            </thead>
            <tbody>${itemRows}</tbody>
          </table>

          <div style="margin-top:24px;padding:16px;background:#f8fafc;border-radius:8px;font-size:12px;color:#6b7280;text-align:center;">
            ${companyName}에서 발송한 발주서입니다. 확인 후 발주확인서를 회신 부탁드립니다.
          </div>
        </div>
      </div>`

    const { error: emailError } = await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: recipient_email,
      subject: `[발주서] ${doc.supplier_name || ''} ${doc.order_number || ''}`,
      html
    })

    if (emailError) {
      console.error('📧 발주서 발송 실패:', emailError)
      return NextResponse.json({ sent: false, reason: emailError.message })
    }

    const sentAt = new Date().toISOString()
    await supabase.from('approval_documents').update({
      supplier_email: recipient_email,
      po_sent_at: sentAt,
      po_sent_to: recipient_email
    }).eq('id', document_id)

    return NextResponse.json({ sent: true, sent_at: sentAt, sent_to: recipient_email })

  } catch (error) {
    console.error('send-purchase-order 에러:', error)
    return NextResponse.json({ sent: false, reason: '서버 오류' }, { status: 500 })
  }
}
