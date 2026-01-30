import { NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

interface HistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

interface InventoryItem {
  product_id: string
  warehouse_id: string
  quantity: number
  products: { product_name: string }
  warehouses: { name: string }
}

export async function POST(request: Request) {
  try {
    const { message, products, warehouses, inventory, history } = await request.json()

    // 제품 목록을 문자열로 변환
    const productList = products.map((p: { product_name: string; product_code: string }) =>
      `- ${p.product_name} (${p.product_code})`
    ).join('\n')

    // 창고 목록을 문자열로 변환
    const warehouseList = warehouses.map((w: { name: string }) => `- ${w.name}`).join('\n')

    // 재고 현황을 문자열로 변환 (제품별로 어떤 창고에 얼마나 있는지)
    const inventoryList = (inventory || []).map((item: InventoryItem) =>
      `- ${item.products?.product_name}: ${item.warehouses?.name}에 ${item.quantity}개`
    ).join('\n')

    const systemPrompt = `당신은 재고관리 AI 어시스턴트입니다. 스스로 추론하여 필요한 정보만 질문하세요.

## 현재 데이터
**등록된 제품:**
${productList || '(없음)'}

**등록된 창고:**
${warehouseList || '(없음)'}

**재고 현황:**
${inventoryList || '(없음)'}

## 응답 형식 (JSON만)
{
  "action": "입고" | "출고" | "창고이동" | "조회" | "질문" | "완료",
  "product_name": "확정된 제품명",
  "quantity": 숫자,
  "warehouse": "출고 창고",
  "to_warehouse": "도착 창고 (창고이동시)",
  "channel": "외부 채널 (외부출고시)",
  "message": "사용자에게 보여줄 메시지",
  "pending": { "product": true/false, "warehouse": true/false, "type": true/false, "channel": true/false }
}

## 핵심 원칙: 스스로 추론하여 필요한 것만 질문

### 1. 제품 확인
- 키워드로 1개만 매칭 → 확정 (질문 안함)
- 키워드로 여러 개 매칭 → 질문 필요
- 예: "데일리퍼품" → 1개만 있으면 바로 확정

### 2. 창고 확인
- 해당 제품이 1개 창고에만 재고 있음 → 자동 선택 (질문 안함)
- 여러 창고에 재고 있음 → 질문 필요
- 예: 충주창고에만 있으면 바로 "충주창고" 확정

### 3. 출고 유형 판단 (외부출고 vs 창고이동)
- 메시지에 외부 채널/지역 키워드 있음 → 외부출고 확정 (질문 안함)
  - 외부 키워드: 올리브영, 홈쇼핑, 쿠팡, 네이버, 오산, 수원 등 (창고명이 아닌 것)
- 메시지에 창고명 언급 (본사, 충주 등) → 창고이동 가능성 있음
- 둘 다 불명확 → "외부출고인가요, 창고이동인가요?" 질문

### 4. 채널 확인 (외부출고시 필수!)
- 외부출고인데 채널 정보 있음 → 확정 (질문 안함)
- 외부출고인데 채널 정보 없음 → "어느 채널로 출고할까요?" 질문
- **창고이동이면 채널 질문 절대 안함!**

## 예시

### "데일리퍼품 300개 올리브영 출고" (제품 1개, 창고 1개만 재고)
→ 모든 정보 확정 → 바로 처리
{
  "action": "출고",
  "product_name": "데일리퍼품",
  "quantity": 300,
  "warehouse": "충주창고",
  "channel": "올리브영",
  "message": "출고 등록:\\n- 제품: 데일리퍼품\\n- 수량: 300개\\n- 창고: 충주창고\\n- 채널: 올리브영"
}

### "화이트닝 100 홈쇼핑 출고" (제품 1개, 창고 여러 개)
→ 창고만 질문
{
  "action": "질문",
  "product_name": "화이트닝세럼",
  "quantity": 100,
  "channel": "홈쇼핑",
  "message": "어느 창고에서 출고할까요?\\n- 충주창고: 500개\\n- 본사사무실: 100개",
  "pending": { "warehouse": true }
}

### "쿠션 100 출고" (제품 1개, 창고 1개, 채널 없음)
→ 채널만 질문
{
  "action": "질문",
  "product_name": "데일리쿠션",
  "quantity": 100,
  "warehouse": "충주창고",
  "message": "외부출고인가요, 창고이동인가요?\\n(외부출고면 채널을 알려주세요: 올리브영, 홈쇼핑 등)",
  "pending": { "type": true, "channel": true }
}

### "쿠션 50개 본사로 이동"
→ 창고이동 확정, 채널 질문 안함
{
  "action": "창고이동",
  "product_name": "데일리쿠션",
  "quantity": 50,
  "warehouse": "충주창고",
  "to_warehouse": "본사사무실",
  "message": "창고이동 등록:\\n- 제품: 데일리쿠션\\n- 수량: 50개\\n- 충주창고 → 본사사무실"
}

### 대화 맥락 처리
- 이전에 질문했고 사용자가 답변하면 → 해당 정보 채워서 다음 단계로
- "충주", "1", "올리브영" 같은 짧은 답변은 이전 질문에 대한 답변

## 수량 추론
- "100" → 100개
- "천개" → 1000개
- "오백" → 500개

JSON만 응답하세요.`

    // 대화 히스토리를 메시지에 포함
    const historyMessages: Array<{ role: 'user' | 'assistant'; content: string }> =
      (history || []).map((h: HistoryMessage) => ({
        role: h.role,
        content: h.content
      }))

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: message }
      ],
      temperature: 0.1,
    })

    const content = completion.choices[0].message.content || '{}'

    // JSON 파싱 시도
    let parsed
    try {
      // ```json ... ``` 형식 제거
      const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim()
      parsed = JSON.parse(jsonStr)
    } catch {
      parsed = { action: 'unknown', message: '요청을 이해하지 못했습니다. 다시 말씀해주세요.' }
    }

    return NextResponse.json(parsed)
  } catch (error) {
    console.error('OpenAI API 에러:', error)
    return NextResponse.json(
      { error: 'AI 처리 중 오류가 발생했습니다.' },
      { status: 500 }
    )
  }
}
