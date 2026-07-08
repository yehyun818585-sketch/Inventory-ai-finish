import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { getInboundReconciliation, getOutboundReconciliation, getTransferReconciliation, classifyMissing } from '@/lib/reconciliation'

const resend = new Resend(process.env.RESEND_API_KEY)

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRowLike = any

function buildRows(
  items: AnyRowLike[],
  valueLabel: (item: AnyRowLike) => string
) {
  return items.map((item, i) => `
    <tr style="border-bottom:1px solid #f0f0f0;">
      <td style="padding:10px 8px;font-weight:500;">${i + 1}. [${item.source}] ${item.product_name}</td>
      <td style="padding:10px 8px;color:#666;">${item.display_location}</td>
      <td style="padding:10px 8px;text-align:right;font-weight:bold;">${valueLabel(item)}</td>
    </tr>`).join('')
}

function buildEmailHtml(companyName: string, headline: string, sections: { label: string; color: string; rows: string; count: number }[]) {
  return `
    <div style="font-family:-apple-system,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">
      <div style="background:#2563eb;padding:24px 32px;border-radius:12px 12px 0 0;">
        <h1 style="margin:0;color:white;font-size:20px;">재고관리 AI</h1>
        <p style="margin:4px 0 0;color:#bfdbfe;font-size:13px;">결재 증빙 ↔ 실물기록 대사 알림</p>
      </div>
      <div style="background:white;padding:28px 32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
        <p style="margin:0 0 20px;font-size:15px;">
          안녕하세요.<br/>
          <strong>${companyName}</strong>${headline}<br/>
          확인 후 조치해 주세요.
        </p>
        ${sections.filter(s => s.count > 0).map(s => `
        <div style="margin-bottom:24px;">
          <h3 style="margin:0 0 8px;padding:8px 12px;background:${s.color}15;border-left:4px solid ${s.color};color:${s.color};font-size:14px;">
            ${s.label} (${s.count}건)
          </h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tbody>${s.rows}</tbody>
          </table>
        </div>`).join('')}
        <div style="margin-top:24px;padding:16px;background:#f8fafc;border-radius:8px;font-size:12px;color:#6b7280;text-align:center;">
          재고관리 AI 시스템에서 자동 발송된 메일입니다.
        </div>
      </div>
    </div>`
}

export async function POST(request: Request) {
  try {
    const { company_id } = await request.json()
    if (!company_id) return NextResponse.json({ error: 'company_id 필요' }, { status: 400 })

    const supabase = getSupabaseAdmin()

    const { data: companyData } = await supabase
      .from('companies')
      .select('name, reconciliation_grace_days')
      .eq('id', company_id)
      .single()
    const companyName = companyData?.name || '회사'
    const graceDays = companyData?.reconciliation_grace_days ?? 3

    const [inbound, outbound, transfer] = await Promise.all([
      getInboundReconciliation(company_id, supabase),
      getOutboundReconciliation(company_id, supabase),
      getTransferReconciliation(company_id, supabase)
    ])

    const allMissing = [
      ...inbound.progress.filter(p => p.remaining_qty > 0).map(p => ({ ...p, source: '입고' as const })),
      ...outbound.progress.filter(p => p.remaining_qty > 0).map(p => ({ ...p, source: '출고' as const })),
      ...transfer.progress.filter(p => p.remaining_qty > 0).map(p => ({ ...p, source: '이동' as const }))
    ]
    // 거래처 확정 납기일 + 유예(α)를 넘긴 건만 적발 대상 (확정 전/기한 전인 건은 알림 대상 아님)
    const overdueMissing = allMissing.filter(m => classifyMissing(m, graceDays) === 'overdue')
    const stage1List = overdueMissing.filter(m => !m.stage1_alert_sent_at)
    const escalationList = overdueMissing.filter(m => m.stage1_alert_sent_at)

    const unmatched = [
      ...inbound.unmatched.map(u => ({ ...u, source: '입고' })),
      ...outbound.unmatched.map(u => ({ ...u, source: '출고' })),
      ...transfer.unmatched.map(u => ({ ...u, source: '이동' }))
    ]

    if (overdueMissing.length === 0 && unmatched.length === 0) {
      return NextResponse.json({ sent: false, reason: '예외 사항 없음' })
    }

    let stage1Sent = false
    let escalationSent = false
    let unmatchedSent = false

    // ── 1차: 기한 초과 건 최초 알림 → 창고담당자 ──
    if (stage1List.length > 0) {
      const { data: warehouseUsers } = await supabase
        .from('profiles').select('email').eq('company_id', company_id).eq('role', '창고')
      if (warehouseUsers && warehouseUsers.length > 0) {
        const rows = buildRows(stage1List, (item: AnyRowLike) => `미달 ${item.remaining_qty.toLocaleString()} (${item.actual_qty.toLocaleString()}/${item.approved_qty.toLocaleString()})`)
        const html = buildEmailHtml(companyName, `의 입고/출고 실물기록이 예정일+유예(${graceDays}일)를 넘겼습니다.`, [
          { label: '🚨 기한 초과 미기록/미달 (1차 알림)', color: '#f59e0b', rows, count: stage1List.length }
        ])
        const { error } = await resend.emails.send({
          from: 'onboarding@resend.dev',
          to: warehouseUsers.map(u => u.email),
          subject: `[재고관리 AI] 입출고 지연 1차 알림 - ${stage1List.length}건`,
          html
        })
        if (!error) {
          stage1Sent = true
          const docIds = [...new Set(stage1List.map(m => m.document_id))]
          await supabase.from('approval_documents').update({ stage1_alert_sent_at: new Date().toISOString() }).in('id', docIds)
        } else {
          console.error('📧 1차 알림 발송 실패:', error)
        }
      }
    }

    // ── 에스컬레이션: 1차 알림에도 미해소 → 승인자(관리책임자/대표) ──
    if (escalationList.length > 0) {
      const { data: approvers } = await supabase
        .from('profiles').select('email').eq('company_id', company_id).in('position', ['관리책임자', '대표'])
      if (approvers && approvers.length > 0) {
        const rows = buildRows(escalationList, (item: AnyRowLike) => `미달 ${item.remaining_qty.toLocaleString()} (${item.actual_qty.toLocaleString()}/${item.approved_qty.toLocaleString()})`)
        const html = buildEmailHtml(companyName, `의 입출고 지연 건이 1차 알림 이후에도 해소되지 않아 에스컬레이션합니다.`, [
          { label: '🚨 에스컬레이션: 미해소 지연 건', color: '#ef4444', rows, count: escalationList.length }
        ])
        const { error } = await resend.emails.send({
          from: 'onboarding@resend.dev',
          to: approvers.map(a => a.email),
          subject: `[재고관리 AI] 입출고 지연 에스컬레이션 - ${escalationList.length}건`,
          html
        })
        if (!error) {
          escalationSent = true
          const docIds = [...new Set(escalationList.map(m => m.document_id))]
          await supabase.from('approval_documents').update({ escalated_at: new Date().toISOString() }).in('id', docIds)
        } else {
          console.error('📧 에스컬레이션 발송 실패:', error)
        }
      }
    }

    // ── 기존: 기록있음·증빙없음 → 본사 (변경 없음) ──
    if (unmatched.length > 0) {
      const { data: managers } = await supabase
        .from('profiles').select('email').eq('company_id', company_id).eq('role', '본사')
      if (managers && managers.length > 0) {
        const rows = buildRows(unmatched, (item: AnyRowLike) => `${item.quantity.toLocaleString()}개 (${item.reason})`)
        const html = buildEmailHtml(companyName, '의 승인 증빙 없이 처리된(또는 승인수량을 초과한) 실물기록이 감지되었습니다.', [
          { label: '🚨 기록 있음 · 증빙 없음', color: '#ef4444', rows, count: unmatched.length }
        ])
        const { error } = await resend.emails.send({
          from: 'onboarding@resend.dev',
          to: managers.map(m => m.email),
          subject: `[재고관리 AI] 결재 대사 예외 알림 - ${unmatched.length}건`,
          html
        })
        if (!error) unmatchedSent = true
        else console.error('📧 기록있음·증빙없음 알림 발송 실패:', error)
      }
    }

    const sent = stage1Sent || escalationSent || unmatchedSent
    console.log(`📧 대사 알림 발송 결과 → 1차:${stage1Sent} 에스컬레이션:${escalationSent} 미매칭:${unmatchedSent}`)
    return NextResponse.json({
      sent,
      stage1_sent: stage1Sent,
      escalation_sent: escalationSent,
      unmatched_sent: unmatchedSent,
      stage1_count: stage1List.length,
      escalation_count: escalationList.length,
      unmatched_count: unmatched.length
    })

  } catch (error) {
    console.error('check-reconciliation-alert 에러:', error)
    return NextResponse.json({ error: '서버 오류' }, { status: 500 })
  }
}
