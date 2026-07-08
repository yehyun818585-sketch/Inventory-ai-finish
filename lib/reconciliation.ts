import { SupabaseClient } from '@supabase/supabase-js'
import { supabase as defaultClient } from '@/lib/supabase'

// 승인 증빙(approval_documents) 대비 실물 트랜잭션(transactions) 대사 유틸.
// "지시 증빙(Q) ↔ 실물 기록(Q)" 원칙: 유형별 기준 키로 승인수량을 실적에 문서 생성순으로
// 소진시켜, 미달분(progress)과 증빙 없는 초과분(unmatched)을 분리해서 반환한다.
// 기준 키: 입고=제품+창고, 출고=제품+채널, 이동=제품+출발창고+도착창고.

// 예정일(expected_date) + 유예(grace_days)를 넘겼는지 판단하는 공용 헬퍼.
// expected_date가 없는 문서(마이그레이션 이전 데이터 등)는 판단 불가하므로 true(기존처럼 항상 노출)로 하위호환 처리.
export function isOverdue(expectedDate: string | null, graceDays: number): boolean {
  if (!expectedDate) return true
  const due = new Date(expectedDate)
  due.setDate(due.getDate() + graceDays)
  return new Date() > due
}

// 이동품의서는 확정납기 개념이 없어 항상 expected_date 기준(=항상 즉시노출)으로 판단.
// 발주/출고는 거래처가 실제 확정해준 confirmed_date가 있어야 기한초과 여부를 판단할 수 있음 — 없으면 "확정 대기".
export function classifyMissing(
  row: { source: '입고' | '출고' | '이동'; expected_date: string | null; confirmed_date: string | null },
  graceDays: number
): 'overdue' | 'pending' | 'awaiting' {
  if (row.source === '이동') return isOverdue(row.expected_date, graceDays) ? 'overdue' : 'pending'
  if (!row.confirmed_date) return 'awaiting'
  return isOverdue(row.confirmed_date, graceDays) ? 'overdue' : 'pending'
}

export interface ReconciliationProgressRow {
  document_id: string
  product_id: string
  product_name: string
  product_code: string
  display_location: string
  approved_qty: number
  actual_qty: number
  remaining_qty: number
  approved_by: string | null
  approved_at: string | null
  expected_date: string | null
  confirmed_date: string | null
  stage1_alert_sent_at: string | null
  escalated_at: string | null
}

export interface UnmatchedRow {
  product_id: string
  product_name: string
  display_location: string
  quantity: number
  reason: '승인문서 없음' | '승인수량 초과'
}

interface DisplaySample {
  display_location: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any

async function reconcile(
  client: SupabaseClient,
  companyId: string,
  docType: '발주품의서' | '출고지시서' | '이동품의서',
  txType: '입고' | '출고' | '이동',
  docSecondaryKey: (doc: AnyRow) => { key: string; display: string },
  txSecondaryKey: (tx: AnyRow) => { key: string; display: string }
): Promise<{ progress: ReconciliationProgressRow[]; unmatched: UnmatchedRow[] }> {
  const { data: docs } = await client
    .from('approval_documents')
    .select(`
      id, warehouse_id, to_warehouse_id, channel, approved_by, approved_at, created_at,
      expected_date, confirmed_date, stage1_alert_sent_at, escalated_at,
      warehouses:warehouse_id ( name ),
      to_warehouse:to_warehouse_id ( name ),
      approval_document_items ( product_id, quantity, products ( product_name, product_code ) )
    `)
    .eq('company_id', companyId)
    .eq('doc_type', docType)
    .eq('status', '승인')
    .order('created_at', { ascending: true })

  const { data: txs } = await client
    .from('transactions')
    .select('product_id, warehouse_id, channel, quantity, note, products(product_name, product_code), warehouses(name)')
    .eq('company_id', companyId)
    .eq('type', txType)

  const productNameById: Record<string, { product_name: string; product_code: string }> = {}
  const actualByKey: Record<string, number> = {}
  const sampleByKey: Record<string, DisplaySample> = {}

  ;(txs || []).forEach((t: AnyRow) => {
    if (t.product_id && t.products) productNameById[t.product_id] = { product_name: t.products.product_name, product_code: t.products.product_code }
    const { key: locKey, display } = txSecondaryKey(t)
    const key = `${t.product_id}::${locKey}`
    actualByKey[key] = (actualByKey[key] || 0) + t.quantity
    if (!sampleByKey[key]) sampleByKey[key] = { display_location: display }
  })

  const keysWithDoc = new Set<string>()
  const consumedByKey: Record<string, number> = {}
  const progress: ReconciliationProgressRow[] = []

  ;(docs || []).forEach((doc: AnyRow) => {
    const { key: locKey, display } = docSecondaryKey(doc)
    ;(doc.approval_document_items || []).forEach((item: AnyRow) => {
      const key = `${item.product_id}::${locKey}`
      keysWithDoc.add(key)
      if (!sampleByKey[key]) sampleByKey[key] = { display_location: display }

      const totalActual = actualByKey[key] || 0
      const alreadyClaimed = consumedByKey[key] || 0
      const availableActual = Math.max(0, totalActual - alreadyClaimed)
      const claim = Math.min(availableActual, item.quantity)
      consumedByKey[key] = alreadyClaimed + claim

      progress.push({
        document_id: doc.id,
        product_id: item.product_id,
        product_name: item.products?.product_name || productNameById[item.product_id]?.product_name || '',
        product_code: item.products?.product_code || productNameById[item.product_id]?.product_code || '',
        display_location: display,
        approved_qty: item.quantity,
        actual_qty: claim,
        remaining_qty: item.quantity - claim,
        approved_by: doc.approved_by,
        approved_at: doc.approved_at,
        expected_date: doc.expected_date ?? null,
        confirmed_date: doc.confirmed_date ?? null,
        stage1_alert_sent_at: doc.stage1_alert_sent_at ?? null,
        escalated_at: doc.escalated_at ?? null
      })
    })
  })

  const unmatched: UnmatchedRow[] = []
  Object.entries(actualByKey).forEach(([key, total]) => {
    const claimed = consumedByKey[key] || 0
    const leftover = total - claimed
    if (leftover <= 0) return
    const productId = key.split('::')[0]
    unmatched.push({
      product_id: productId,
      product_name: productNameById[productId]?.product_name || '',
      display_location: sampleByKey[key]?.display_location || '',
      quantity: leftover,
      reason: keysWithDoc.has(key) ? '승인수량 초과' : '승인문서 없음'
    })
  })

  return { progress, unmatched }
}

export function getInboundReconciliation(companyId: string, client: SupabaseClient = defaultClient) {
  return reconcile(
    client, companyId, '발주품의서', '입고',
    (doc: AnyRow) => ({ key: `${doc.warehouse_id}`, display: doc.warehouses?.name || '(창고 미상)' }),
    (tx: AnyRow) => ({ key: `${tx.warehouse_id}`, display: tx.warehouses?.name || '(창고 미상)' })
  )
}

export function getOutboundReconciliation(companyId: string, client: SupabaseClient = defaultClient) {
  return reconcile(
    client, companyId, '출고지시서', '출고',
    (doc: AnyRow) => ({ key: `${doc.channel || ''}`, display: doc.channel || '(채널 미상)' }),
    (tx: AnyRow) => ({ key: `${tx.channel || ''}`, display: tx.channel || '(채널 미상)' })
  )
}

export function getTransferReconciliation(companyId: string, client: SupabaseClient = defaultClient) {
  return reconcile(
    client, companyId, '이동품의서', '이동',
    (doc: AnyRow) => {
      const to = doc.to_warehouse?.name || '(도착창고 미상)'
      return { key: `${doc.warehouse_id}::${to}`, display: `${doc.warehouses?.name || '(창고 미상)'} → ${to}` }
    },
    (tx: AnyRow) => {
      // 이동 실적은 note에 "출발창고 → 도착창고" 형태로만 저장되어 있어 창고명으로 매칭
      let toName = '(도착창고 미상)'
      if (tx.note) {
        const match = tx.note.match(/^(.+?) → (.+?)(?:\s*\(|$)/)
        if (match) toName = match[2].trim()
      }
      return { key: `${tx.warehouse_id}::${toName}`, display: `${tx.warehouses?.name || '(창고 미상)'} → ${toName}` }
    }
  )
}

// ── 3자 대사 확장: 실물기록(transactions) ↔ 외부 제3자 증빙(거래명세서/운송장) ──
// 위의 reconcile()/get*Reconciliation은 "승인 Q ↔ 실물 Q"(1↔2 다리)만 다루며 그대로 둔다.
// 아래 함수들은 "실물 Q ↔ 외부증빙 Q"(2↔3 다리)만 별도로 체크해, 조합하면 3자 대사가 완성된다.

export interface EvidenceExceptionRow {
  transaction_id: string
  product_name: string
  warehouse_name: string | null
  quantity: number
  evidence_quantity: number | null
  evidence_file_url: string | null
  created_at: string
  reason: '증빙 미첨부' | '증빙수량 불일치' | '증빙 미입력'
}

export interface NonTransportRow {
  transaction_id: string
  product_name: string
  quantity: number
  shipping_type: string
  created_at: string
}

export async function getInboundEvidenceExceptions(
  companyId: string,
  client: SupabaseClient = defaultClient
): Promise<EvidenceExceptionRow[]> {
  const { data: txs } = await client
    .from('transactions')
    .select('id, quantity, evidence_file_url, evidence_quantity, created_at, products(product_name), warehouses(name)')
    .eq('company_id', companyId)
    .eq('type', '입고')

  const exceptions: EvidenceExceptionRow[] = []
  ;(txs || []).forEach((t: AnyRow) => {
    if (!t.evidence_file_url) {
      exceptions.push({
        transaction_id: t.id,
        product_name: t.products?.product_name || '',
        warehouse_name: t.warehouses?.name || null,
        quantity: t.quantity,
        evidence_quantity: null,
        evidence_file_url: null,
        created_at: t.created_at,
        reason: '증빙 미첨부'
      })
    } else if (t.evidence_quantity !== t.quantity) {
      exceptions.push({
        transaction_id: t.id,
        product_name: t.products?.product_name || '',
        warehouse_name: t.warehouses?.name || null,
        quantity: t.quantity,
        evidence_quantity: t.evidence_quantity,
        evidence_file_url: t.evidence_file_url,
        created_at: t.created_at,
        reason: '증빙수량 불일치'
      })
    }
  })
  return exceptions
}

export async function getOutboundEvidenceExceptions(
  companyId: string,
  client: SupabaseClient = defaultClient
): Promise<{ exceptions: EvidenceExceptionRow[]; nonTransport: NonTransportRow[] }> {
  const { data: txs } = await client
    .from('transactions')
    .select('id, quantity, evidence_file_url, evidence_quantity, shipping_type, created_at, products(product_name), warehouses(name)')
    .eq('company_id', companyId)
    .eq('type', '출고')

  const exceptions: EvidenceExceptionRow[] = []
  const nonTransport: NonTransportRow[] = []

  ;(txs || []).forEach((t: AnyRow) => {
    const base = {
      transaction_id: t.id,
      product_name: t.products?.product_name || '',
      warehouse_name: t.warehouses?.name || null,
      quantity: t.quantity,
      evidence_quantity: t.evidence_quantity ?? null,
      evidence_file_url: t.evidence_file_url ?? null,
      created_at: t.created_at
    }

    if (!t.shipping_type) {
      exceptions.push({ ...base, reason: '증빙 미입력' })
      return
    }
    if (t.shipping_type === '자차배송' || t.shipping_type === '직접픽업') {
      // 비운송 건: 운송장 부재가 정상이므로 예외로 띄우지 않고 정보성 목록으로만 분리 (적발통제 취지상 완전히 숨기지 않음)
      nonTransport.push({
        transaction_id: t.id,
        product_name: t.products?.product_name || '',
        quantity: t.quantity,
        shipping_type: t.shipping_type,
        created_at: t.created_at
      })
      return
    }
    // 택배/화물: 운송장 첨부 + 수량 일치 필요
    if (!t.evidence_file_url) {
      exceptions.push({ ...base, reason: '증빙 미첨부' })
    } else if (t.evidence_quantity !== t.quantity) {
      exceptions.push({ ...base, reason: '증빙수량 불일치' })
    }
  })

  return { exceptions, nonTransport }
}
