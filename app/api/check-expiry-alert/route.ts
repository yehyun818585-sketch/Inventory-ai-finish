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
    const { company_id } = await request.json()
    if (!company_id) return NextResponse.json({ error: 'company_id 필요' }, { status: 400 })

    const supabase = getSupabaseAdmin()
    const today = new Date()

    // 1. 회사 정보 + 설정 조회
    const { data: companyData } = await supabase
      .from('companies')
      .select('name, default_shelf_life_months, shelf_life_warning_ratio')
      .eq('id', company_id)
      .single()

    const defaultSL = companyData?.default_shelf_life_months || 24
    const warningRatio = companyData?.shelf_life_warning_ratio || 0.25
    const companyName = companyData?.name || '회사'

    // 2. 재고 조회
    const { data: inventory } = await supabase
      .from('inventory')
      .select('quantity, lot_number, products(product_name, shelf_life_months), warehouses(name)')
      .eq('company_id', company_id)
      .gt('quantity', 0)

    // 3. 임박/만료 분류
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const expiring: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const expired: any[] = []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(inventory || []).forEach((item: any) => {
      if (!item.lot_number || !/^\d{6}/.test(item.lot_number)) return
      const yy = parseInt(item.lot_number.substring(0, 2))
      const mm = parseInt(item.lot_number.substring(2, 4)) - 1
      const dd = parseInt(item.lot_number.substring(4, 6))
      if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return

      const sl = item.products?.shelf_life_months || defaultSL
      const expiry = new Date(2000 + yy, mm, dd)
      expiry.setMonth(expiry.getMonth() + sl)
      const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000)
      const threshold = sl * 30 * warningRatio

      const row = {
        product: item.products?.product_name,
        warehouse: item.warehouses?.name,
        lot: item.lot_number,
        quantity: item.quantity,
        daysLeft
      }

      if (daysLeft <= 0) expired.push(row)
      else if (daysLeft <= threshold) expiring.push(row)
    })

    // 임박/만료 없으면 종료
    if (expiring.length === 0 && expired.length === 0) {
      return NextResponse.json({ sent: false, reason: '임박/만료 상품 없음' })
    }

    // 4. 창고담당자 이메일 조회
    const { data: warehouseUsers } = await supabase
      .from('profiles')
      .select('email, name')
      .eq('company_id', company_id)
      .eq('role', '창고')

    if (!warehouseUsers || warehouseUsers.length === 0) {
      return NextResponse.json({ sent: false, reason: '창고담당자 계정 없음' })
    }

    // 5. HTML 이메일 생성
    const totalCount = expiring.length + expired.length
    const subject = `[재고관리 AI] 유통기한 임박 상품 알림 - ${totalCount}건`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildRows = (items: any[], label: string, color: string) => {
      if (items.length === 0) return ''
      const rows = items.map((item, i) => `
        <tr style="border-bottom:1px solid #f0f0f0;">
          <td style="padding:10px 8px;font-weight:500;">${i + 1}. ${item.product}</td>
          <td style="padding:10px 8px;color:#666;">LOT: ${item.lot}</td>
          <td style="padding:10px 8px;color:#666;">${item.warehouse}</td>
          <td style="padding:10px 8px;text-align:right;">${item.quantity.toLocaleString()}개</td>
          <td style="padding:10px 8px;text-align:right;font-weight:bold;color:${color};">
            ${item.daysLeft <= 0 ? '만료됨' : `D-${item.daysLeft}일`}
          </td>
        </tr>`).join('')

      return `
        <div style="margin-bottom:24px;">
          <h3 style="margin:0 0 8px;padding:8px 12px;background:${color}15;border-left:4px solid ${color};color:${color};font-size:14px;">
            ${label} (${items.length}건)
          </h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#f8f9fa;color:#888;">
                <th style="padding:8px;text-align:left;">제품명</th>
                <th style="padding:8px;text-align:left;">로트번호</th>
                <th style="padding:8px;text-align:left;">창고</th>
                <th style="padding:8px;text-align:right;">수량</th>
                <th style="padding:8px;text-align:right;">상태</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`
    }

    const html = `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#2563eb;padding:24px 32px;border-radius:12px 12px 0 0;">
          <h1 style="margin:0;color:white;font-size:20px;">재고관리 AI</h1>
          <p style="margin:4px 0 0;color:#bfdbfe;font-size:13px;">유통기한 임박/만료 상품 알림</p>
        </div>
        <div style="background:white;padding:28px 32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
          <p style="margin:0 0 20px;font-size:15px;">
            안녕하세요.<br/>
            <strong>${companyName}</strong>의 유통기한 임박/만료 상품이 감지되었습니다.<br/>
            즉시 확인 후 조치해 주세요.
          </p>
          ${buildRows(expired, '🚨 만료 상품', '#ef4444')}
          ${buildRows(expiring, '⚠️ 임박 상품', '#f59e0b')}
          <div style="margin-top:24px;padding:16px;background:#f8fafc;border-radius:8px;font-size:12px;color:#6b7280;text-align:center;">
            재고관리 AI 시스템에서 자동 발송된 메일입니다.
          </div>
        </div>
      </div>`

    // 6. 발송
    const recipients = warehouseUsers.map(u => u.email)
    const { error: emailError } = await resend.emails.send({
      from: '재고관리 AI <notify@attude.uk>',
      to: recipients,
      subject,
      html
    })

    if (emailError) {
      console.error('📧 이메일 발송 실패:', emailError)
      return NextResponse.json({ sent: false, reason: emailError.message })
    }

    return NextResponse.json({
      sent: true,
      recipients,
      expiring_count: expiring.length,
      expired_count: expired.length
    })

  } catch (error) {
    console.error('check-expiry-alert 에러:', error)
    return NextResponse.json({ error: '서버 오류' }, { status: 500 })
  }
}
