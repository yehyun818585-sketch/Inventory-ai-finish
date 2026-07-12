import { SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { getInboundReconciliation, getOutboundReconciliation, getTransferReconciliation, classifyMissing } from '@/lib/reconciliation'

const resend = new Resend(process.env.RESEND_API_KEY)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRowLike = any

function buildRows(items: AnyRowLike[], valueLabel: (item: AnyRowLike) => string) {
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

export interface ReconciliationAlertResult {
  sent: boolean
  stage1_sent: boolean
  escalation_sent: boolean
  unmatched_sent: boolean
  due_today_sent: boolean
  stage1_count: number
  escalation_count: number
  unmatched_count: number
  due_today_count: number
}

export async function runReconciliationAlertForCompany(
  companyId: string,
  supabase: SupabaseClient
): Promise<ReconciliationAlertResult> {
  const { data: companyData } = await supabase
    .from('companies')
    .select('name, reconciliation_grace_days, outbound_grace_days, shipping_cutoff_time')
    .eq('id', companyId)
    .single()
  const companyName = companyData?.name || '회사'
  const graceBySource = {
    default: companyData?.reconciliation_grace_days ?? 3,
    outbound: companyData?.outbound_grace_days ?? 0
  }
  const cutoffTime = companyData?.shipping_cutoff_time || '15:00'

  const [inbound, outbound, transfer] = await Promise.all([
    getInboundReconciliation(companyId, supabase),
    getOutboundReconciliation(companyId, supabase),
    getTransferReconciliation(companyId, supabase)
  ])

  const allMissing = [
    ...inbound.progress.filter(p => p.remaining_qty > 0).map(p => ({ ...p, source: '입고' as const })),
    ...outbound.progress.filter(p => p.remaining_qty > 0).map(p => ({ ...p, source: '출고' as const })),
    ...transfer.progress.filter(p => p.remaining_qty > 0).map(p => ({ ...p, source: '이동' as const }))
  ]
  // 거래처 확정 납기일(또는 출고는 회사가 정한 마감규칙) + 유예를 넘긴 건만 적발 대상
  const overdueMissing = allMissing.filter(m => classifyMissing(m, graceBySource) === 'overdue')
  const stage1List = overdueMissing.filter(m => !m.stage1_alert_sent_at)
  const escalationList = overdueMissing.filter(m => m.stage1_alert_sent_at)

  // 오늘 마감(하루 1회 발송 정책) 전에 아직 실물 출고가 안 끝난 건 — 기한초과는 아니지만 오늘 안에 처리해야 할 목록
  const todayStr = new Date().toISOString().split('T')[0]
  const dueTodayList = outbound.progress.filter(p => p.remaining_qty > 0 && p.confirmed_date === todayStr)

  const unmatched = [
    ...inbound.unmatched.map(u => ({ ...u, source: '입고' })),
    ...outbound.unmatched.map(u => ({ ...u, source: '출고' })),
    ...transfer.unmatched.map(u => ({ ...u, source: '이동' }))
  ]

  const result: ReconciliationAlertResult = {
    sent: false, stage1_sent: false, escalation_sent: false, unmatched_sent: false, due_today_sent: false,
    stage1_count: stage1List.length, escalation_count: escalationList.length,
    unmatched_count: unmatched.length, due_today_count: dueTodayList.length
  }

  if (overdueMissing.length === 0 && unmatched.length === 0 && dueTodayList.length === 0) {
    return result
  }

  // ── 오늘 마감 전 미처리 + 1차 기한초과(며칠 지연) → 창고담당자에게 한 번에 ──
  if (dueTodayList.length > 0 || stage1List.length > 0) {
    const { data: warehouseUsers } = await supabase
      .from('profiles').select('email').eq('company_id', companyId).eq('role', '창고')
    if (warehouseUsers && warehouseUsers.length > 0) {
      const sections = []
      if (dueTodayList.length > 0) {
        const rows = buildRows(dueTodayList, (item: AnyRowLike) => `미출고 ${item.remaining_qty.toLocaleString()} (${item.actual_qty.toLocaleString()}/${item.approved_qty.toLocaleString()})`)
        sections.push({ label: `⏰ 오늘(${cutoffTime} 마감) 안에 처리해야 할 출고`, color: '#f59e0b', rows, count: dueTodayList.length })
      }
      if (stage1List.length > 0) {
        const rows = buildRows(stage1List, (item: AnyRowLike) => `미달 ${item.remaining_qty.toLocaleString()} (${item.actual_qty.toLocaleString()}/${item.approved_qty.toLocaleString()})`)
        sections.push({ label: '🚨 기한 초과 미기록/미달 (1차 알림)', color: '#ef4444', rows, count: stage1List.length })
      }
      const html = buildEmailHtml(companyName, '의 입출고 처리가 필요한 건이 있습니다.', sections)
      const { error } = await resend.emails.send({
        from: '재고관리 AI <notify@attude.uk>',
        to: warehouseUsers.map(u => u.email),
        subject: `[재고관리 AI] 입출고 처리 알림 - ${dueTodayList.length + stage1List.length}건`,
        html
      })
      if (!error) {
        result.due_today_sent = dueTodayList.length > 0
        result.stage1_sent = stage1List.length > 0
        if (stage1List.length > 0) {
          const docIds = [...new Set(stage1List.map(m => m.document_id))]
          await supabase.from('approval_documents').update({ stage1_alert_sent_at: new Date().toISOString() }).in('id', docIds)
        }
      } else {
        console.error('📧 창고담당 알림 발송 실패:', error)
      }
    }
  }

  // ── 에스컬레이션: 1차 알림에도 미해소 → 승인자(관리책임자/대표) ──
  if (escalationList.length > 0) {
    const { data: approvers } = await supabase
      .from('profiles').select('email').eq('company_id', companyId).in('position', ['관리책임자', '대표'])
    if (approvers && approvers.length > 0) {
      const rows = buildRows(escalationList, (item: AnyRowLike) => `미달 ${item.remaining_qty.toLocaleString()} (${item.actual_qty.toLocaleString()}/${item.approved_qty.toLocaleString()})`)
      const html = buildEmailHtml(companyName, '의 입출고 지연 건이 1차 알림 이후에도 해소되지 않아 에스컬레이션합니다.', [
        { label: '🚨 에스컬레이션: 미해소 지연 건', color: '#ef4444', rows, count: escalationList.length }
      ])
      const { error } = await resend.emails.send({
        from: '재고관리 AI <notify@attude.uk>',
        to: approvers.map(a => a.email),
        subject: `[재고관리 AI] 입출고 지연 에스컬레이션 - ${escalationList.length}건`,
        html
      })
      if (!error) {
        result.escalation_sent = true
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
      .from('profiles').select('email').eq('company_id', companyId).eq('role', '본사')
    if (managers && managers.length > 0) {
      const rows = buildRows(unmatched, (item: AnyRowLike) => `${item.quantity.toLocaleString()}개 (${item.reason})`)
      const html = buildEmailHtml(companyName, '의 승인 증빙 없이 처리된(또는 승인수량을 초과한) 실물기록이 감지되었습니다.', [
        { label: '🚨 기록 있음 · 증빙 없음', color: '#ef4444', rows, count: unmatched.length }
      ])
      const { error } = await resend.emails.send({
        from: '재고관리 AI <notify@attude.uk>',
        to: managers.map(m => m.email),
        subject: `[재고관리 AI] 결재 대사 예외 알림 - ${unmatched.length}건`,
        html
      })
      if (!error) result.unmatched_sent = true
      else console.error('📧 기록있음·증빙없음 알림 발송 실패:', error)
    }
  }

  result.sent = result.stage1_sent || result.escalation_sent || result.unmatched_sent || result.due_today_sent
  console.log(`📧 대사 알림 발송 결과(${companyId}) → 오늘마감:${result.due_today_sent} 1차:${result.stage1_sent} 에스컬레이션:${result.escalation_sent} 미매칭:${result.unmatched_sent}`)
  return result
}

// ── 내부사용 반출: 건별 사전품의 대신 주간요약 + 월말확인의 이중 점검으로 대체 ──
// (근거: 회사가 원래 월말 실사 1회에만 의존해 월중 공백이 있었음 → 주간요약으로 검토 주기를 앞당기고,
//  월말엔 AI 리포트 확인을 직접 유도해 반드시 인지시킨다.)

function isMonday(date: Date): boolean {
  return date.getDay() === 1
}

function isNearMonthEnd(date: Date): boolean {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  return date.getDate() >= lastDay - 2
}

// 이번 달에 이미 확인했는지 (연-월 비교)
function isConfirmedThisMonth(confirmedAt: string | null, now: Date): boolean {
  if (!confirmedAt) return false
  const c = new Date(confirmedAt)
  return c.getFullYear() === now.getFullYear() && c.getMonth() === now.getMonth()
}

// 매주 월요일: 지난 7일간 내부사용 반출 요약을 전 직원에게 발송 (있을 때만)
export async function runInternalUseWeeklyDigest(
  companyId: string,
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<{ sent: boolean }> {
  if (!isMonday(now)) return { sent: false }

  const { data: companyData } = await supabase
    .from('companies').select('name').eq('id', companyId).single()
  const companyName = companyData?.name || '회사'

  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: txs } = await supabase
    .from('transactions')
    .select('quantity, note, created_at, internal_use_category, internal_use_recipient_name, internal_use_confirmed_at, products(product_name)')
    .eq('company_id', companyId)
    .eq('type', '출고')
    .eq('sub_type', '내부사용')
    .gte('created_at', weekAgo)
    .order('created_at', { ascending: false })

  if (!txs || txs.length === 0) return { sent: false }

  const { data: allUsers } = await supabase.from('profiles').select('email').eq('company_id', companyId)
  if (!allUsers || allUsers.length === 0) return { sent: false }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = txs.map((t: AnyRowLike, i: number) => {
    const detailMatch = t.note?.match(/\[내부사용:([^\]]+)\] 수령자: ([^|]+)/)
    const category = t.internal_use_category || detailMatch?.[1] || '-'
    const recipient = t.internal_use_recipient_name || detailMatch?.[2]?.trim() || '-'
    const confirmStatus = t.internal_use_category === '샘플'
      ? (t.internal_use_confirmed_at ? ' · 수령확인 완료' : ' · 수령확인 대기')
      : ''
    return `
      <tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:10px 8px;font-weight:500;">${i + 1}. ${t.products?.product_name || ''}</td>
        <td style="padding:10px 8px;color:#666;">${category} · ${recipient}${confirmStatus}</td>
        <td style="padding:10px 8px;text-align:right;font-weight:bold;">${t.quantity.toLocaleString()}개</td>
      </tr>`
  }).join('')

  const html = buildEmailHtml(companyName, '의 최근 7일간 내부사용 반출 내역입니다.', [
    { label: '📦 내부사용 반출 (샘플/협찬)', color: '#d97706', rows, count: txs.length }
  ])

  const { error } = await resend.emails.send({
    from: '재고관리 AI <notify@attude.uk>',
    to: allUsers.map(u => u.email),
    subject: `[재고관리 AI] 주간 내부사용 반출 요약 - ${txs.length}건`,
    html
  })
  if (error) { console.error('📧 내부사용 주간요약 발송 실패:', error); return { sent: false } }
  return { sent: true }
}

// 월말(마지막 3일): 이번 달 AI 리포트 확인이 아직 안 됐으면 리마인드 발송
export async function runMonthlyReportReminder(
  companyId: string,
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<{ sent: boolean }> {
  if (!isNearMonthEnd(now)) return { sent: false }

  const { data: companyData } = await supabase
    .from('companies').select('name, monthly_report_confirmed_at').eq('id', companyId).single()
  if (!companyData) return { sent: false }
  if (isConfirmedThisMonth(companyData.monthly_report_confirmed_at, now)) return { sent: false }

  const { data: allUsers } = await supabase.from('profiles').select('email').eq('company_id', companyId)
  if (!allUsers || allUsers.length === 0) return { sent: false }

  const html = buildEmailHtml(companyData.name || '회사', '의 이번 달 AI 리포트(재고 현황·폐기 위험 등) 확인이 아직 안 됐습니다.', [
    { label: '📊 월말 AI 리포트 확인 필요', color: '#d97706', rows: `
      <tr><td style="padding:10px 8px;">대시보드에 접속해 이번 달 리포트를 확인해주세요.</td></tr>`, count: 1 }
  ])

  const { error } = await resend.emails.send({
    from: '재고관리 AI <notify@attude.uk>',
    to: allUsers.map(u => u.email),
    subject: `[재고관리 AI] 월말 리포트 확인 요청`,
    html
  })
  if (error) { console.error('📧 월말 리포트 리마인드 발송 실패:', error); return { sent: false } }
  return { sent: true }
}
