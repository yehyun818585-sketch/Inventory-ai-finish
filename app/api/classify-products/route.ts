import { NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function POST(request: Request) {
  try {
    const { productNames } = await request.json()

    if (!productNames || !Array.isArray(productNames) || productNames.length === 0) {
      return NextResponse.json({ suggest_off: [], needs_review: [] })
    }

    console.log('🤖 [분류] 제품 분류 요청:', productNames.length, '개')

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `당신은 재고 유통기한 관리 분류 전문가입니다.
제품명 목록을 보고 아래 세 갈래 중 해당하는 것만 JSON에 포함합니다.

## 분류 기준

### suggest_off (유통기한 관리 OFF 추천)
이름만 봐도 포장재·비소모품 단품임이 명백하고, 세트/기획 가능성 키워드가 없는 경우.
예: 파우치, 박스, 포장박스, 케이스, 홀더, 컵, 텀블러, 수저, 머그, 우산, 가방, 충전기, 케이블, 이어폰, 스피커, 인형, 키링, 뱃지, 거울, 액자, 양말, 장갑, 모자

### needs_review (사람 확인 필요 — 최우선 판단 기준)
아래 조건 중 하나라도 해당하면 suggest_off보다 우선하여 needs_review에 넣음:
- 제품명에 "기획", "세트", "증정", "구성", "패키지", "선물", "기프트", "콜라보", "한정판", "에디션"이 포함됨
  → 포장재(박스·파우치 등) 형태여도 내용물에 화장품이 포함될 수 있음
  예: "기획 파우치", "증정 박스", "콜라보 케이스", "선물세트 패키지"
- 비소모품 형태이지만 채널명·브랜드명이 결합되어 내용물이 불확실한 경우
  예: "올리브영 기획용 파우치", "틴트 증정 박스"

### 아무 목록에도 넣지 말 것 (조용히 ON 처리)
- 화장품·뷰티: 쿠션, 파운데이션, 립스틱, 틴트, 아이섀도, 마스카라, 블러셔, 선크림, 로션, 크림, 세럼, 에센스, 앰플, 토너, 미스트, 스킨, 클렌저, 폼클렌징, 팩, 마스크팩, 퍼퓸, 향수, BB크림, CC크림, 프라이머, 컨실러, 하이라이터, 브론저, 젤, 왁스, 샴푸, 컨디셔너, 트리트먼트, 바디로션, 바디워시, 핸드크림
- 식품·음료: 모든 식품, 음료, 주류, 과자, 건강식품, 영양제, 비타민, 프로틴, 콜라겐
- 화장품·식품임이 명백하면 어느 목록에도 넣지 않음
  예: "데일리쿠션", "로맨틱퍼퓸", "수분크림", "비타민C" → 목록 제외

## 중요 규칙 (우선순위 순서)
1. 화장품·식품 단품이 명백 → 어느 목록에도 넣지 않음 (ON 통과)
2. 세트/기획/증정/콜라보 등 내용물 불확실 키워드 존재 → needs_review (포장재 형태여도 예외 없음)
3. 포장재·비소모품 단품이 명백하고 2번 키워드 없음 → suggest_off
4. 위 세 경우 모두 아니면 → 목록 제외 (ON 통과)
- suggest_off와 needs_review는 서로 겹치지 않음
- 비소모품 키워드가 없는데 단순히 제품명이 짧거나 불명확하다고 needs_review에 넣지 말 것

JSON으로만 응답 (다른 텍스트 없이):
{"suggest_off": ["제품명"], "needs_review": ["제품명"]}`
        },
        {
          role: 'user',
          content: `다음 제품들을 분류해 주세요:\n${productNames.join('\n')}`
        }
      ],
      temperature: 0.1,
      max_tokens: 1000
    })

    const content = response.choices[0]?.message?.content || '{}'
    console.log('🤖 [분류] AI 응답:', content)

    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      console.log('🤖 [분류] suggest_off:', parsed.suggest_off || [], '/ needs_review:', parsed.needs_review || [])
      return NextResponse.json({
        suggest_off: parsed.suggest_off || [],
        needs_review: parsed.needs_review || []
      })
    }

    return NextResponse.json({ suggest_off: [], needs_review: [] })
  } catch (error) {
    console.error('🤖 [분류] 에러:', error)
    return NextResponse.json({ suggest_off: [], needs_review: [] })
  }
}
