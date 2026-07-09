import { SupabaseClient } from '@supabase/supabase-js'

// 출고지시서 승인 후, 실제 피킹 전에 "어느 로트에서 얼마나 뺄지" 미리 보여주기 위한
// 읽기 전용 FIFO 계산. app/transactions/page.tsx의 실제 차감 로직(만료/임박 로트 제외 +
// 로트번호 오름차순 FIFO)과 같은 규칙을 참고했지만, 재고를 실제로 바꾸지 않는 미리보기 전용
// 별도 구현이다. 피킹 시점까지 재고가 바뀔 수 있으므로 결과는 "예상치"로만 취급해야 한다.

export interface LotPreviewEntry {
  lot_number: string | null
  quantity: number
}

export interface LotPreviewResult {
  breakdown: LotPreviewEntry[]
  shortfall: number
}

interface InventoryLot {
  quantity: number
  lot_number: string | null
}

function isExpiredOrWarning(lot: InventoryLot, shelfLifeMonths: number, today: Date): boolean {
  if (!lot.lot_number || !/^\d{6}-\d{2}$/.test(lot.lot_number)) return false
  const y = parseInt('20' + lot.lot_number.substring(0, 2))
  const m = parseInt(lot.lot_number.substring(2, 4)) - 1
  const d = parseInt(lot.lot_number.substring(4, 6))
  const expiry = new Date(y, m, d)
  expiry.setMonth(expiry.getMonth() + shelfLifeMonths)
  const days = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  return days <= shelfLifeMonths * 30 * 0.25
}

export async function previewFifoDeduction(
  client: SupabaseClient,
  productId: string,
  warehouseId: string,
  neededQty: number,
  shelfLifeMonths: number
): Promise<LotPreviewResult> {
  const { data: lots } = await client
    .from('inventory')
    .select('quantity, lot_number')
    .eq('product_id', productId)
    .eq('warehouse_id', warehouseId)
    .gt('quantity', 0)

  const today = new Date()
  const eligible = ((lots || []) as InventoryLot[])
    .filter(l => !isExpiredOrWarning(l, shelfLifeMonths, today))
    .sort((a, b) => (a.lot_number || '').localeCompare(b.lot_number || ''))

  let remaining = neededQty
  const breakdown: LotPreviewEntry[] = []
  for (const lot of eligible) {
    if (remaining <= 0) break
    const take = Math.min(lot.quantity, remaining)
    if (take > 0) breakdown.push({ lot_number: lot.lot_number, quantity: take })
    remaining -= take
  }
  return { breakdown, shortfall: remaining }
}
