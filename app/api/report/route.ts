import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// 서버 API에서는 service_role 키 사용 (RLS 우회)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// 날짜를 YY.MM.DD 형식으로 변환
function formatDateShort(dateStr: string): string {
  const date = new Date(dateStr)
  const yy = String(date.getFullYear()).slice(2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}.${mm}.${dd}`
}

// AI를 사용하여 비소모품(유통기한 불필요) 제품 분류
async function classifyPerishableProducts(productNames: string[]): Promise<Set<string>> {
  if (productNames.length === 0) return new Set()

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `당신은 제품 분류 전문가입니다. 제품명 목록을 보고 "유통기한이 필요 없는 제품"을 판별합니다.

유통기한이 필요 없는 제품 예시:
- 의류/패션: 우산, 파우치, 가방, 모자, 장갑, 양말, 티셔츠
- 생활용품: 컵, 텀블러, 접시, 그릇, 수저, 케이스, 홀더
- 문구류: 펜, 노트, 메모장, 스티커
- 완구/장식: 인형, 피규어, 장난감, 키링, 뱃지

유통기한이 필요한 제품:
- 식품류: 음료, 과자, 조미료, 소스, 식재료
- 건강식품: 영양제, 보충제, 건강음료
- 화장품: 스킨케어, 메이크업 (개봉 후 사용기한)

JSON 형식으로 응답: {"nonPerishable": ["제품명1", "제품명2"]}`
        },
        {
          role: 'user',
          content: `다음 제품 중 유통기한이 필요 없는 제품만 선택하세요:\n${productNames.join('\n')}`
        }
      ],
      temperature: 0.1,
      max_tokens: 500
    })

    const content = response.choices[0]?.message?.content || '{}'
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      console.log('📊 [AI] 비소모품 분류 결과:', parsed.nonPerishable || [])
      return new Set(parsed.nonPerishable || [])
    }
  } catch (error) {
    console.error('📊 [AI] 제품 분류 에러:', error)
  }

  return new Set()
}

export async function POST() {
  try {
    console.log('📊 [AI 리포트] 데이터 수집 시작...')

    // 1. 재고 현황 조회
    const { data: inventory } = await supabase
      .from('inventory')
      .select(`
        quantity,
        lot_number,
        created_at,
        products (product_name, product_code, product_group, shelf_life_months),
        warehouses (name)
      `)

    // 2. 현재 월의 시작일과 종료일 계산
    const today = new Date()
    const currentYear = today.getFullYear()
    const currentMonth = today.getMonth()
    const monthStart = new Date(currentYear, currentMonth, 1)
    const monthEnd = new Date(currentYear, currentMonth + 1, 0) // 이번 달 마지막 날

    // 월 표시용 문자열
    const monthLabel = `${currentYear}년 ${currentMonth + 1}월`

    // 3. 현재 월의 입출고 기록
    const { data: transactions } = await supabase
      .from('transactions')
      .select(`
        type,
        quantity,
        channel,
        created_at,
        products (product_name)
      `)
      .gte('created_at', monthStart.toISOString())
      .lte('created_at', today.toISOString())

    // 4. 창고 목록
    const { data: warehouses } = await supabase
      .from('warehouses')
      .select('name')

    // 데이터 요약 생성
    const inventorySummary = inventory?.map(i => ({
      제품: (i.products as { product_name: string })?.product_name,
      창고: (i.warehouses as { name: string })?.name,
      수량: i.quantity,
      로트: i.lot_number
    })) || []

    const transactionSummary = transactions?.map(t => ({
      유형: t.type,
      제품: (t.products as { product_name: string })?.product_name,
      수량: t.quantity,
      채널: t.channel,
      날짜: t.created_at
    })) || []

    // 총 재고 계산
    const totalStock = inventory?.reduce((sum, i) => sum + i.quantity, 0) || 0

    // 창고별 재고 계산
    const stockByWarehouse: Record<string, number> = {}
    inventory?.forEach(i => {
      const wName = (i.warehouses as { name: string })?.name || '미지정'
      stockByWarehouse[wName] = (stockByWarehouse[wName] || 0) + i.quantity
    })

    // 출고 통계
    const outbound = transactions?.filter(t => t.type === '출고') || []
    const totalOutbound = outbound.reduce((sum, t) => sum + t.quantity, 0)

    // 채널별 출고
    const outboundByChannel: Record<string, number> = {}
    outbound.forEach(t => {
      const ch = t.channel || '기타'
      outboundByChannel[ch] = (outboundByChannel[ch] || 0) + t.quantity
    })

    // 날짜별 출고 체크 (출고 없는 날 감지)
    const outboundByDate: Record<string, number> = {}
    outbound.forEach(t => {
      const date = t.created_at.split('T')[0]
      outboundByDate[date] = (outboundByDate[date] || 0) + t.quantity
    })

    // 현재 월 1일부터 오늘까지 출고 없는 날 계산
    const noOutboundDays: string[] = []
    const checkDate = new Date(monthStart)

    // 월 1일부터 오늘까지 순회
    while (checkDate <= today) {
      const dateStr = checkDate.toISOString().split('T')[0]
      const dayOfWeek = checkDate.getDay()

      // 주말(토,일) 제외
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        if (!outboundByDate[dateStr]) {
          noOutboundDays.push(formatDateShort(dateStr))
        }
      }
      checkDate.setDate(checkDate.getDate() + 1)
    }

    // 유통기한 임박/만료 상품 분석 (lots 페이지와 동일한 기준: 25% 이하일 때 임박)
    const expiringProducts: { name: string; lot: string; qty: number; daysLeft: number; status: string }[] = []

    console.log('📊 [DEBUG] 재고 항목 수:', inventory?.length || 0)

    // AI로 비소모품 분류 (한 번만 호출)
    const uniqueProductNames = [...new Set(
      inventory?.map(item => (item.products as { product_name: string })?.product_name).filter(Boolean) || []
    )]
    const nonPerishableSet = await classifyPerishableProducts(uniqueProductNames)

    inventory?.forEach(item => {
      const lotNumber = item.lot_number
      if (!lotNumber || lotNumber.length < 6) {
        console.log('📊 [DEBUG] 로트번호 스킵:', lotNumber, '(길이 부족)')
        return
      }

      const productName = (item.products as { product_name: string })?.product_name || '알수없음'

      // AI가 분류한 비소모품은 유통기한 체크 안함
      if (nonPerishableSet.has(productName)) {
        console.log('📊 [DEBUG] 비소모품 스킵 (AI 분류):', productName)
        return
      }

      // 로트번호에서 제조일 추출 (YYMMDD)
      const yy = parseInt(lotNumber.substring(0, 2))
      const mm = parseInt(lotNumber.substring(2, 4)) - 1
      const dd = parseInt(lotNumber.substring(4, 6))
      if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return

      const mfgDate = new Date(2000 + yy, mm, dd)
      // 제품별 유통기한 사용 (없으면 기본 24개월)
      const shelfLifeMonths = (item.products as { shelf_life_months: number | null })?.shelf_life_months || 24
      const expiryDate = new Date(mfgDate)
      expiryDate.setMonth(expiryDate.getMonth() + shelfLifeMonths)

      const daysLeft = Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

      // lots 페이지와 동일: 유통기한 25% 이하일 때 임박
      const totalDays = shelfLifeMonths * 30
      const warningThresholdDays = totalDays * 0.25

      console.log('📊 [DEBUG] 로트분석:', {
        lot: lotNumber,
        product: productName,
        daysLeft,
        threshold: warningThresholdDays,
        isExpired: daysLeft <= 0,
        isWarning: daysLeft > 0 && daysLeft <= warningThresholdDays
      })

      if (daysLeft <= 0) {
        expiringProducts.push({
          name: productName,
          lot: lotNumber,
          qty: item.quantity,
          daysLeft,
          status: '만료'
        })
      } else if (daysLeft <= warningThresholdDays) {
        expiringProducts.push({
          name: productName,
          lot: lotNumber,
          qty: item.quantity,
          daysLeft,
          status: '임박'
        })
      }
    })

    // 임박/만료 정렬
    expiringProducts.sort((a, b) => a.daysLeft - b.daysLeft)

    console.log('📊 [DEBUG] 최종 임박/만료 상품 수:', expiringProducts.length)
    if (expiringProducts.length > 0) {
      console.log('📊 [DEBUG] 임박/만료 목록:', expiringProducts)
    }

    console.log('📊 [AI 리포트] 데이터 수집 완료, AI 분석 시작...')

    const prompt = `당신은 재고관리 전문가입니다. 아래 데이터를 분석하여 한국어로 간결한 리포트를 작성해주세요.

## 현재 데이터

### 재고 현황
- 총 재고: ${totalStock.toLocaleString()}개
- 창고별: ${Object.entries(stockByWarehouse).map(([k, v]) => `${k}: ${v.toLocaleString()}개`).join(', ') || '데이터 없음'}

### 재고 상세 (상위 10개)
${inventorySummary.slice(0, 10).map(i => `- ${i.제품}: ${i.창고} ${i.수량}개`).join('\n') || '데이터 없음'}

### 출고 현황
- 총 출고: ${totalOutbound.toLocaleString()}개
- 채널별: ${Object.entries(outboundByChannel).map(([k, v]) => `${k}: ${v.toLocaleString()}개`).join(', ') || '데이터 없음'}

### 출고 없는 날 (${monthLabel}, 평일 기준)
- 출고 없는 날짜: ${noOutboundDays.length > 0 ? noOutboundDays.join(', ') : '없음'}
- 출고 없는 날 수: ${noOutboundDays.length}일

### 유통기한 임박/만료 상품
${expiringProducts.length > 0 ? expiringProducts.slice(0, 10).map(p =>
  `- [${p.status}] ${p.name} (LOT: ${p.lot}) ${p.qty}개 - ${p.daysLeft <= 0 ? '이미 만료됨' : `${p.daysLeft}일 남음`}`
).join('\n') : '없음'}

## 리포트 형식 (마크다운) - 추천액션 섹션 없이, 각 섹션에 권고사항 포함

### 요약
(2-3줄로 핵심 현황)

### 출고 이상 감지
- ${monthLabel} 출고 기록을 분석했습니다.
- 출고 없는 날이 있으면: 해당 날짜를 모두 나열하고 (예: ${noOutboundDays.slice(0, 3).join(', ')} 등)
- 바로 아래에 "→ 권고: 출고 기록 누락 여부 확인 필요" 형태로 권고사항 작성
- 출고 없는 날이 없으면: "정상 - 모든 평일에 출고 기록이 있습니다."

### 유통기한 관리
- 임박 상품이 있으면: 상품명과 남은 기한 나열 후 "→ 권고: 떨이 판매 또는 증정용 활용 검토"
- 만료 상품이 있으면: 상품명 나열 후 "→ 권고: 폐기처분 및 재고자산 감액 회계처리 필요"
- 해당사항 없으면: "정상 - 임박/만료 상품 없음"

중요: "추천 액션" 섹션을 별도로 만들지 마세요. 모든 권고사항은 해당 섹션 내에 "→ 권고:" 형태로 즉시 작성하세요.
간결하게 작성하세요. 데이터가 부족하면 "데이터 부족"이라고 명시하세요.`

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: '재고관리 전문가로서 간결하고 실용적인 리포트를 작성합니다.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 800
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
        productCount: new Set(inventory?.map(i => (i.products as { product_name: string })?.product_name)).size,
        monthLabel,
        noOutboundDaysCount: noOutboundDays.length
      }
    })
  } catch (error) {
    console.error('📊 [AI 리포트] 에러:', error)
    return NextResponse.json({ error: 'AI 리포트 생성 중 오류 발생' }, { status: 500 })
  }
}
