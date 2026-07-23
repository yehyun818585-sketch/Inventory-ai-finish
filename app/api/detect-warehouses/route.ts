import { NextResponse } from 'next/server'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function POST(request: Request) {
  try {
    const { columns } = await request.json()

    if (!columns || !Array.isArray(columns)) {
      return NextResponse.json({ error: '컬럼 목록이 필요합니다' }, { status: 400 })
    }


    // 재고 관련 컬럼만 필터링
    const qtyKeywords = ['재고', '수량', 'qty', 'quantity', 'stock']
    const inventoryColumns = columns.filter((col: string) => {
      const colLower = col.toLowerCase()
      return qtyKeywords.some(kw => colLower.includes(kw.toLowerCase()))
    })

    if (inventoryColumns.length === 0) {
      return NextResponse.json({ warehouses: [] })
    }


    const prompt = `다음은 엑셀 파일의 컬럼명 목록입니다. 이 중에서 "실제 물리적 창고/지점/위치"를 나타내는 컬럼만 골라주세요.

컬럼 목록: ${inventoryColumns.join(', ')}

규칙:
1. 실제 창고/지점/위치: 충주창고, 본사, 오산물류센터, 뉴욕지점, 한국창고, 파리지사 등 (O)
2. 제외 대상: 가용재고, 최소재고, 최대재고, 안전재고, 총재고, 현재고, 출고수량, 입고수량, 예약재고 등 (X)

응답 형식 (JSON만, 다른 텍스트 없이):
{"warehouses": [{"column": "원본컬럼명", "name": "추출된창고명"}]}

예시:
입력: 충주창고재고, 본사사무실재고, 가용재고, 최소재고
출력: {"warehouses": [{"column": "충주창고재고", "name": "충주창고"}, {"column": "본사사무실재고", "name": "본사사무실"}]}

창고가 없으면: {"warehouses": []}`

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: '당신은 엑셀 컬럼명에서 실제 창고/지점을 식별하는 전문가입니다. JSON 형식으로만 응답하세요.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    })

    const content = response.choices[0]?.message?.content || '{"warehouses": []}'

    const result = JSON.parse(content)

    return NextResponse.json(result)
  } catch (error) {
    console.error('🤖 [AI] 에러:', error)
    return NextResponse.json({ error: 'AI 처리 중 오류 발생', warehouses: [] }, { status: 500 })
  }
}
