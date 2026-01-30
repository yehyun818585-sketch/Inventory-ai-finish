import { NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function POST(request: Request) {
  try {
    const { productNames } = await request.json()

    if (!productNames || !Array.isArray(productNames) || productNames.length === 0) {
      return NextResponse.json({ nonPerishable: [] })
    }

    console.log('🤖 [AI] 제품 분류 요청:', productNames.length, '개')

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `당신은 제품 분류 전문가입니다. 제품명 목록을 보고 "유통기한이 필요 없는 제품"을 판별합니다.

유통기한이 필요 없는 제품 예시:
- 의류/패션: 우산, 파우치, 가방, 모자, 장갑, 양말, 티셔츠, 슬리퍼, 신발
- 생활용품: 컵, 텀블러, 접시, 그릇, 수저, 케이스, 홀더, 받침대, 스탠드
- 문구류: 펜, 노트, 메모장, 스티커, 파일, 바인더
- 완구/장식: 인형, 피규어, 장난감, 키링, 뱃지, 액자, 거울
- 전자기기: 충전기, 케이블, 이어폰, 스피커

유통기한이 필요한 제품:
- 식품류: 음료, 과자, 조미료, 소스, 식재료, 차, 커피
- 건강식품: 영양제, 보충제, 건강음료, 비타민
- 화장품: 스킨케어, 메이크업, 로션, 크림

JSON 형식으로 응답: {"nonPerishable": ["제품명1", "제품명2"]}`
        },
        {
          role: 'user',
          content: `다음 제품 중 유통기한이 필요 없는 제품만 선택하세요:\n${productNames.join('\n')}`
        }
      ],
      temperature: 0.1,
      max_tokens: 1000
    })

    const content = response.choices[0]?.message?.content || '{}'
    console.log('🤖 [AI] 분류 응답:', content)

    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      console.log('🤖 [AI] 비소모품 목록:', parsed.nonPerishable || [])
      return NextResponse.json({ nonPerishable: parsed.nonPerishable || [] })
    }

    return NextResponse.json({ nonPerishable: [] })
  } catch (error) {
    console.error('🤖 [AI] 분류 에러:', error)
    return NextResponse.json({ nonPerishable: [] })
  }
}
