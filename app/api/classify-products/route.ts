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
          content: `당신은 제품 분류 전문가입니다. 제품명 목록을 보고 유통기한 관리 필요 여부를 두 그룹으로 분류합니다.

## suggest_off (유통기한 관리 OFF 추천 - 명확하게 비소모품인 경우)
- 의류/패션 단품: 우산, 파우치, 가방, 모자, 장갑, 양말, 티셔츠, 슬리퍼, 신발
- 생활용품 단품: 컵, 텀블러, 접시, 그릇, 수저, 케이스, 홀더, 받침대, 스탠드
- 문구류: 펜, 노트, 메모장, 스티커, 파일, 바인더
- 완구/장식 단품: 인형, 피규어, 장난감, 키링, 뱃지, 액자, 거울
- 전자기기: 충전기, 케이블, 이어폰, 스피커

## needs_review (확인 필요 - 세트상품 가능성 있거나 애매한 경우)
- "기획", "세트", "박스", "box", "set", "패키지", "선물세트"가 이름에 포함된 경우
  → 화장품 단품이 들어갔을 수 있어서 유통기한 관리가 필요할 수 있음
- 채널명+제품명 조합 (예: "올리브영 기획용 파우치") → 내용물 불확실
- 제품군이 불명확한 경우

## 규칙
- 화장품(스킨케어, 메이크업, 로션, 크림, 세럼, 에센스 등)은 두 그룹 모두에 포함하지 않음 (유통기한 ON 유지)
- 식품, 건강식품도 포함하지 않음
- 확신이 없으면 suggest_off 대신 needs_review에 넣을 것

JSON 형식으로 응답:
{"suggest_off": ["제품명1"], "needs_review": ["제품명2"]}`
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
