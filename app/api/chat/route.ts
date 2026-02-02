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

    const systemPrompt = `당신은 재고관리 AI 어시스턴트입니다. 대화 맥락을 이해하고, 필요한 정보만 질문하세요.

## 현재 데이터
**등록된 제품:**
${productList || '(없음)'}

**등록된 창고:**
${warehouseList || '(없음)'}

**재고 현황:**
${inventoryList || '(없음)'}

## 응답 형식 (JSON만)
{
  "action": "입고" | "출고" | "창고이동" | "조회" | "질문",
  "product_name": "확정된 제품명 (정확한 전체 이름)",
  "quantity": 숫자,
  "warehouse": "출고 창고",
  "to_warehouse": "도착 창고 (창고이동시)",
  "channel": "외부 채널 (외부출고시)",
  "message": "사용자에게 보여줄 메시지"
}

## 핵심: 순서대로 확인하고, 모르는 것만 질문

### 확인 순서 (반드시 이 순서대로!)
1. **제품 확인** (가장 먼저!)
2. **창고 확인**
3. **출고 유형 확인** (외부출고 vs 창고이동)
4. **채널 확인** (외부출고일 때만)

### 1. 제품 확인 규칙
- 사용자가 입력한 키워드가 **여러 제품명에 포함**되면 → 반드시 질문!
- 예: "화이트닝" 입력 → "화이트닝세럼", "화이트닝크림" 2개 존재 → 질문 필수
- 예: "쿠션" 입력 → "데일리쿠션" 1개만 존재 → 바로 확정
- **1개만 매칭되면 질문 안함, 2개 이상 매칭되면 반드시 질문**

### 2. 창고 확인 규칙
- 해당 제품 재고가 1개 창고에만 있음 → 자동 선택
- 여러 창고에 있음 → 질문 필요

### 3. 출고 유형 규칙
- 외부 채널 키워드 있음 (올리브영, 홈쇼핑, 쿠팡 등) → 외부출고
- 창고명 키워드 있음 (본사, 충주 등) + "이동" → 창고이동
- 불명확 → 질문

### 4. 채널 규칙
- 외부출고인데 채널 없음 → 질문 필수
- **창고이동이면 채널 질문 절대 안함!**

## 대화 맥락 처리 (매우 중요!)

이전 대화에서 질문을 했고, 사용자가 짧게 답변하면 그것은 이전 질문에 대한 답변입니다.

### 예시 1: 창고 질문 후 답변
이전: AI가 "어느 창고에서 출고할까요?" 질문
현재: 사용자가 "충주창고" 또는 "충주" 답변
→ 창고를 "충주창고"로 확정하고 다음 단계 진행

### 예시 2: 제품 질문 후 답변
이전: AI가 "어떤 제품인가요? 1.화이트닝세럼 2.화이트닝크림" 질문
현재: 사용자가 "1" 또는 "화이트닝세럼" 답변
→ 제품을 "화이트닝세럼"으로 확정하고 다음 단계 진행

### 예시 3: 채널 질문 후 답변
이전: AI가 "어느 채널로 출고할까요?" 질문
현재: 사용자가 "올리브영" 답변
→ 채널을 "올리브영"으로 확정하고 출고 처리

## 예시 시나리오

### "화이트닝 100 출고" (화이트닝세럼, 화이트닝크림 2개 존재)
→ 제품부터 질문
{
  "action": "질문",
  "quantity": 100,
  "message": "화이트닝 제품이 여러 개 있습니다. 어떤 제품인가요?\\n1. 화이트닝세럼\\n2. 화이트닝크림"
}

### 사용자가 "1" 답변 후 (화이트닝세럼 확정, 충주창고에만 재고)
→ 출고 유형/채널 질문
{
  "action": "질문",
  "product_name": "화이트닝세럼",
  "quantity": 100,
  "warehouse": "충주창고",
  "message": "외부출고인가요, 창고이동인가요?\\n(외부출고면 채널을 알려주세요: 올리브영, 홈쇼핑 등)"
}

### 사용자가 "올리브영" 답변 후
→ 모든 정보 확정, 출고 처리
{
  "action": "출고",
  "product_name": "화이트닝세럼",
  "quantity": 100,
  "warehouse": "충주창고",
  "channel": "올리브영",
  "message": "출고 등록:\\n- 제품: 화이트닝세럼\\n- 수량: 100개\\n- 창고: 충주창고\\n- 채널: 올리브영"
}

## 수량 추론
- "100" → 100개
- "천개" → 1000개

JSON만 응답하세요.`

    // 대화 히스토리를 메시지에 포함
    const historyMessages: Array<{ role: 'user' | 'assistant'; content: string }> =
      (history || []).map((h: HistoryMessage) => ({
        role: h.role,
        content: h.content
      }))

    // 디버깅: 히스토리 확인
    console.log('💬 [Chat] 사용자 메시지:', message)
    console.log('💬 [Chat] 히스토리 길이:', historyMessages.length)
    if (historyMessages.length > 0) {
      console.log('💬 [Chat] 최근 히스토리:', historyMessages.slice(-2))
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: message }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })

    const content = completion.choices[0].message.content || '{}'
    console.log('🤖 [Chat] AI 원본 응답:', content)

    // JSON 파싱 시도
    let parsed
    try {
      // ```json ... ``` 형식 제거
      const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim()
      parsed = JSON.parse(jsonStr)
      console.log('✅ [Chat] 파싱 성공:', parsed.action)
    } catch (e) {
      console.log('❌ [Chat] JSON 파싱 실패:', e)
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
