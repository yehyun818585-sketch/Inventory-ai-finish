import { NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// 날짜를 YY.MM.DD 형식으로 변환 (문자열 파싱, 타임존 이슈 방지)
function formatDateShort(dateStr: string): string {
  const parts = dateStr.split('-')
  const yy = parts[0].slice(2)
  const mm = parts[1]
  const dd = parts[2]
  return `${yy}.${mm}.${dd}`
}

// Date 객체를 로컬 YYYY-MM-DD 문자열로 변환 (toISOString은 UTC라서 사용하면 안됨)
function toLocalDateStr(date: Date): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// 클라이언트에서 전달받는 데이터 타입
interface ClientInventoryItem {
  quantity: number
  lot_number: string | null
  product_name: string
  product_code: string
  product_group: string
  shelf_life_months: number | null
  warehouse_name: string
  track_expiry: boolean
}

interface ClientTransaction {
  type: string
  quantity: number
  channel: string | null
  created_at: string
  product_name: string
}

interface ClientExpiringLot {
  productName: string
  lotNumber: string
  quantity: number
  daysLeft: number
  status: 'warning' | 'expired'
  warehouseName: string
}

interface RequestBody {
  inventory: ClientInventoryItem[]
  transactions: ClientTransaction[]
  warehouses: { name: string }[]
  expiringLots: ClientExpiringLot[]
}

export async function POST(request: Request) {
  try {
    console.log('📊 [AI 리포트] 데이터 수집 시작...')

    // 클라이언트에서 전달받은 데이터 사용
    const body: RequestBody = await request.json()
    const { inventory, transactions, warehouses, expiringLots } = body

    console.log('📊 [DEBUG] 클라이언트 데이터 수신:')
    console.log('  - inventory:', inventory?.length || 0, '개')
    console.log('  - transactions:', transactions?.length || 0, '개')
    console.log('  - warehouses:', warehouses?.length || 0, '개')
    console.log('  - expiringLots:', expiringLots?.length || 0, '개')

    // 현재 월의 시작일 계산
    const today = new Date()
    const currentYear = today.getFullYear()
    const currentMonth = today.getMonth()
    const monthStart = new Date(currentYear, currentMonth, 1)

    // 월 표시용 문자열
    const monthLabel = `${currentYear}년 ${currentMonth + 1}월`

    // 이번 달 트랜잭션만 필터링
    const monthTransactions = (transactions || []).filter(t => {
      const txDate = new Date(t.created_at)
      return txDate >= monthStart && txDate <= today
    })

    console.log('📊 [DEBUG] 이번 달 트랜잭션:', monthTransactions.length, '개')

    // 데이터 요약 생성
    const inventorySummary = (inventory || []).map(i => ({
      제품: i.product_name,
      창고: i.warehouse_name,
      수량: i.quantity,
      로트: i.lot_number
    }))

    // 총 재고 계산
    const totalStock = (inventory || []).reduce((sum, i) => sum + i.quantity, 0)

    // 창고별 재고 계산
    const stockByWarehouse: Record<string, number> = {}
    ;(inventory || []).forEach(i => {
      const wName = i.warehouse_name || '미지정'
      stockByWarehouse[wName] = (stockByWarehouse[wName] || 0) + i.quantity
    })

    // 출고 통계 (이번 달)
    const outbound = monthTransactions.filter(t => t.type === '출고')
    const totalOutbound = outbound.reduce((sum, t) => sum + t.quantity, 0)

    // 채널별 출고
    const outboundByChannel: Record<string, number> = {}
    outbound.forEach(t => {
      const ch = t.channel || '기타'
      outboundByChannel[ch] = (outboundByChannel[ch] || 0) + t.quantity
    })

    // 날짜별 출고 체크 (출고 없는 날 감지) - 로컬 타임존 기준
    const outboundByDate: Record<string, number> = {}
    outbound.forEach(t => {
      const txDate = new Date(t.created_at)
      const date = toLocalDateStr(txDate)
      outboundByDate[date] = (outboundByDate[date] || 0) + t.quantity
    })

    // 현재 월 1일부터 오늘까지 출고 없는 날 계산 (주말 제외)
    const noOutboundDays: string[] = []
    const checkDate = new Date(monthStart)

    while (checkDate <= today) {
      const dateStr = toLocalDateStr(checkDate)
      const dayOfWeek = checkDate.getDay()

      // 주말(토=6, 일=0) 제외
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        if (!outboundByDate[dateStr]) {
          noOutboundDays.push(formatDateShort(dateStr))
        }
      }
      checkDate.setDate(checkDate.getDate() + 1)
    }

    console.log('📊 [DEBUG] 출고 없는 평일:', noOutboundDays)

    // 유통기한 임박/만료 상품 (클라이언트에서 이미 계산된 데이터 사용)
    const expiringProducts = (expiringLots || []).map(lot => ({
      name: lot.productName,
      lot: lot.lotNumber,
      qty: lot.quantity,
      daysLeft: lot.daysLeft,
      status: lot.status === 'expired' ? '만료' : '임박',
      warehouse: lot.warehouseName
    }))

    // 만약 expiringLots가 없으면 inventory에서 직접 계산
    if (expiringProducts.length === 0 && inventory && inventory.length > 0) {
      console.log('📊 [DEBUG] expiringLots가 없어서 직접 계산...')

      inventory.forEach(item => {
        // track_expiry가 false인 제품은 유통기한 계산 제외
        if (item.track_expiry === false) return

        const lotNumber = item.lot_number
        if (!lotNumber || lotNumber.length < 6) return

        // 로트번호에서 제조일 추출 (YYMMDD)
        const yy = parseInt(lotNumber.substring(0, 2))
        const mm = parseInt(lotNumber.substring(2, 4)) - 1
        const dd = parseInt(lotNumber.substring(4, 6))
        if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return

        const mfgDate = new Date(2000 + yy, mm, dd)
        const shelfLifeMonths = item.shelf_life_months || 24
        const expiryDate = new Date(mfgDate)
        expiryDate.setMonth(expiryDate.getMonth() + shelfLifeMonths)

        const daysLeft = Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
        const totalDays = shelfLifeMonths * 30
        const warningThresholdDays = totalDays * 0.25

        if (daysLeft <= 0) {
          expiringProducts.push({
            name: item.product_name,
            lot: lotNumber,
            qty: item.quantity,
            daysLeft,
            status: '만료',
            warehouse: item.warehouse_name
          })
        } else if (daysLeft <= warningThresholdDays) {
          expiringProducts.push({
            name: item.product_name,
            lot: lotNumber,
            qty: item.quantity,
            daysLeft,
            status: '임박',
            warehouse: item.warehouse_name
          })
        }
      })

      // 정렬
      expiringProducts.sort((a, b) => a.daysLeft - b.daysLeft)
    }

    console.log('📊 [DEBUG] 임박/만료 상품:', expiringProducts.length, '개')

    // 제품별 이번 달 출고량 집계
    const outboundByProduct: Record<string, number> = {}
    outbound.forEach(t => {
      const name = t.product_name || '알수없음'
      outboundByProduct[name] = (outboundByProduct[name] || 0) + t.quantity
    })

    // 출고량 상위 제품 정렬
    const topOutboundProducts = Object.entries(outboundByProduct)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)

    // 현재 재고 (제품별 합계)
    const currentStockByProduct: Record<string, number> = {}
    ;(inventory || []).forEach(i => {
      const name = i.product_name || '알수없음'
      currentStockByProduct[name] = (currentStockByProduct[name] || 0) + i.quantity
    })

    // 이번 달 경과 일수 (발주 필요 여부 계산용)
    const daysElapsed = Math.max(1, today.getDate())
    const dailyOutboundRate: Record<string, number> = {}
    topOutboundProducts.forEach(([name, qty]) => {
      dailyOutboundRate[name] = qty / daysElapsed
    })

    // 재고 소진 예상일 계산 (현재고 ÷ 일평균출고)
    const stockRunoutDays: { name: string; outbound: number; stock: number; daysLeft: number; needOrder: boolean }[] = []
    topOutboundProducts.forEach(([name, outboundQty]) => {
      const stock = currentStockByProduct[name] || 0
      const dailyRate = dailyOutboundRate[name]
      const daysLeft = dailyRate > 0 ? Math.floor(stock / dailyRate) : 999
      stockRunoutDays.push({
        name,
        outbound: outboundQty,
        stock,
        daysLeft,
        needOrder: daysLeft < 30  // 30일 이하면 발주 권고
      })
    })

    const orderRecommendations = stockRunoutDays.filter(p => p.needOrder)

    console.log('📊 [AI 리포트] 데이터 수집 완료, AI 분석 시작...')

    const prompt = `당신은 재고관리 전문가입니다. 아래 데이터를 분석하여 한국어로 간결한 리포트를 작성해주세요.

## 현재 데이터

### 재고 현황
- 총 재고: ${totalStock.toLocaleString()}개
- 창고별: ${Object.entries(stockByWarehouse).map(([k, v]) => `${k}: ${v.toLocaleString()}개`).join(', ') || '데이터 없음'}

### 재고 상세 (상위 10개)
${inventorySummary.slice(0, 10).map(i => `- ${i.제품}: ${i.창고} ${i.수량}개`).join('\n') || '데이터 없음'}

### 출고 현황 (${monthLabel})
- 총 출고: ${totalOutbound.toLocaleString()}개
- 채널별: ${Object.entries(outboundByChannel).map(([k, v]) => `${k}: ${v.toLocaleString()}개`).join(', ') || '데이터 없음'}

### 제품별 출고량 TOP (${monthLabel})
${topOutboundProducts.map(([name, qty]) => {
  const stock = currentStockByProduct[name] || 0
  const info = stockRunoutDays.find(p => p.name === name)
  return `- ${name}: 출고 ${qty.toLocaleString()}개 / 현재고 ${stock.toLocaleString()}개 / 소진예상 ${info && info.daysLeft < 999 ? `${info.daysLeft}일` : '여유'}`
}).join('\n') || '데이터 없음'}

### 발주/추가생산 권고 대상 (재고 소진 30일 이하)
${orderRecommendations.length > 0
  ? orderRecommendations.map(p => `- ${p.name}: 현재고 ${p.stock.toLocaleString()}개, 일평균출고 ${p.needOrder ? (p.outbound / daysElapsed).toFixed(1) : '-'}개, 소진예상 ${p.daysLeft}일`).join('\n')
  : '없음 (모든 주요 제품 재고 충분)'}

### 출고 없는 날 (${monthLabel}, 평일 기준 - 주말 제외)
- 출고 없는 날짜: ${noOutboundDays.length > 0 ? noOutboundDays.join(', ') : '없음'}
- 출고 없는 날 수: ${noOutboundDays.length}일

### 유통기한 임박/만료 상품
${expiringProducts.length > 0 ? expiringProducts.slice(0, 10).map(p =>
  `- [${p.status}] ${p.name} (LOT: ${p.lot}, ${p.warehouse}) ${p.qty}개 - ${p.daysLeft <= 0 ? '이미 만료됨' : `${p.daysLeft}일 남음`}`
).join('\n') : '없음'}

## 리포트 형식 (마크다운) - 각 섹션에 권고사항 포함

### 요약
(2-3줄로 핵심 현황)

### 출고 이상 감지
- ${monthLabel} 출고 기록을 분석했습니다. (주말 제외)
- 출고 없는 날이 있으면: 해당 날짜를 모두 나열하고 바로 아래에 "→ 권고: 출고 기록 누락 여부 확인 필요" 작성
- 출고 없는 날이 없으면: "정상 - 모든 평일에 출고 기록이 있습니다."

### 발주/추가생산 권고
- 발주 권고 대상이 있으면: 제품명, 현재고, 소진 예상일 나열 후 "→ 권고: [제품명] 추가 발주(생산) 검토 필요. 현재 재고로 약 N일치 물량만 남음"
- 발주 권고 대상이 없으면: "정상 - 주요 제품 재고 30일 이상 여유"
- 출고 데이터가 없으면: "데이터 부족 - 출고 기록 누적 후 분석 가능"

### 유통기한 관리
- 임박 상품이 있으면: 상품명과 남은 기한 나열 후 "→ 권고: 떨이 판매 또는 증정용 활용 검토"
- 만료 상품이 있으면: 상품명 나열 후 "→ 권고: 폐기처분 및 재고자산 감액 회계처리 필요"
- 해당사항 없으면: "정상 - 임박/만료 상품 없음"

중요: 모든 권고사항은 해당 섹션 내에 "→ 권고:" 형태로 즉시 작성하세요.
간결하게 작성하세요. 데이터가 부족하면 "데이터 부족"이라고 명시하세요.`

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: '재고관리 전문가로서 간결하고 실용적인 리포트를 작성합니다.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 1000
    })

    const report = response.choices[0]?.message?.content || '리포트 생성 실패'
    console.log('📊 [AI 리포트] 생성 완료')

    return NextResponse.json({
      report,
      stats: {
        totalStock,
        stockByWarehouse,
        totalOutbound,
        outboundByChannel,
        warehouseCount: warehouses?.length || 0,
        productCount: new Set(inventory?.map(i => i.product_name)).size,
        monthLabel,
        noOutboundDaysCount: noOutboundDays.length,
        expiringCount: expiringProducts.length,
        orderRecommendationCount: orderRecommendations.length
      }
    })
  } catch (error) {
    console.error('📊 [AI 리포트] 에러:', error)
    return NextResponse.json({ error: 'AI 리포트 생성 중 오류 발생' }, { status: 500 })
  }
}
