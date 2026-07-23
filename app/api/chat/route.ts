import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const resend = new Resend(process.env.RESEND_API_KEY)

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// ── Tool 정의 ──────────────────────────────────────────────
const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_inventory',
      description: '현재 재고 현황 조회. 제품명/창고명으로 필터 가능. 수량, 로트번호, 유통기한 포함.',
      parameters: {
        type: 'object',
        properties: {
          product_name: { type: 'string', description: '제품명 필터 (부분 일치, 선택)' },
          warehouse_name: { type: 'string', description: '창고명 필터 (선택)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_products',
      description: '등록된 제품 목록 조회',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: '제품명 검색어 (선택)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_expiring_items',
      description: '유통기한 임박 또는 만료된 재고 조회',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_outbound_summary',
      description: '이번 달 출고 현황 집계 (제품별, 채널별 출고량)',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_order_recommendations',
      description: '발주/추가생산 필요 제품 분석 (현재고 ÷ 일평균출고로 소진 예상일 계산)',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_today_transactions',
      description: '오늘 입출고 이력 조회',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_email_to_manager',
      description: '본사/관리자(role=본사)에게 이메일 발송. 사용자가 요청한 내용(일부 발췌, 요약, 추가 코멘트 등)을 AI가 편집해서 보냄.',
      parameters: {
        type: 'object',
        properties: {
          subject: {
            type: 'string',
            description: '이메일 제목 (예: [재고관리 AI] 5월 재고 현황 리포트)'
          },
          content: {
            type: 'string',
            description: '사용자 요청에 맞게 AI가 편집한 이메일 본문 내용 (마크다운 가능)'
          }
        },
        required: ['subject', 'content']
      }
    }
  }
]

// ── Tool 실행 ──────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeTool(name: string, args: Record<string, string>, companyId: string): Promise<string> {
  const supabase = getSupabaseAdmin()
  const today = new Date()

  if (name === 'get_products') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = supabase
      .from('products')
      .select('product_name, product_code, shelf_life_months')
      .eq('company_id', companyId)
      .eq('is_active', true)
    if (args.search) query = query.ilike('product_name', `%${args.search}%`)
    const { data } = await query
    return JSON.stringify(data || [])
  }

  if (name === 'get_inventory') {
    const { data } = await supabase
      .from('inventory')
      .select('quantity, lot_number, products(product_name, product_code, shelf_life_months), warehouses(name)')
      .or(`company_id.eq.${companyId},company_id.is.null`)
      .gt('quantity', 0)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let filtered: any[] = data || []
    if (args.product_name) filtered = filtered.filter(i => i.products?.product_name?.includes(args.product_name))
    if (args.warehouse_name) filtered = filtered.filter(i => i.warehouses?.name?.includes(args.warehouse_name))

    // 유통기한 계산 추가
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = filtered.map((item: any) => {
      const row: Record<string, unknown> = {
        product: item.products?.product_name,
        warehouse: item.warehouses?.name,
        quantity: item.quantity,
        lot_number: item.lot_number ?? null
      }
      if (item.lot_number && /^\d{6}/.test(item.lot_number)) {
        const yy = parseInt(item.lot_number.substring(0, 2))
        const mm = parseInt(item.lot_number.substring(2, 4)) - 1
        const dd = parseInt(item.lot_number.substring(4, 6))
        const mfgDate = new Date(2000 + yy, mm, dd)
        const sl = item.products?.shelf_life_months || 24
        const expiry = new Date(mfgDate)
        expiry.setMonth(expiry.getMonth() + sl)
        const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000)
        row.expiry_date = expiry.toISOString().split('T')[0]
        row.days_until_expiry = daysLeft
        row.expiry_status = daysLeft <= 0 ? '만료' : daysLeft <= sl * 30 * 0.25 ? '임박' : '정상'
      }
      return row
    })
    return JSON.stringify(result)
  }

  if (name === 'get_expiring_items') {
    const [{ data: inventory }, { data: companyData }] = await Promise.all([
      supabase.from('inventory')
        .select('quantity, lot_number, products(product_name, shelf_life_months), warehouses(name)')
        .eq('company_id', companyId).gt('quantity', 0),
      supabase.from('companies')
        .select('default_shelf_life_months, shelf_life_warning_ratio')
        .eq('id', companyId).single()
    ])
    const defaultSL = companyData?.default_shelf_life_months || 24
    const warningRatio = companyData?.shelf_life_warning_ratio || 0.25

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (inventory || []).filter((item: any) => {
      if (!item.lot_number || !/^\d{6}/.test(item.lot_number)) return false
      const yy = parseInt(item.lot_number.substring(0, 2))
      const mm = parseInt(item.lot_number.substring(2, 4)) - 1
      const dd = parseInt(item.lot_number.substring(4, 6))
      const sl = item.products?.shelf_life_months || defaultSL
      const expiry = new Date(2000 + yy, mm, dd)
      expiry.setMonth(expiry.getMonth() + sl)
      const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000)
      return daysLeft <= sl * 30 * warningRatio
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }).map((item: any) => {
      const yy = parseInt(item.lot_number.substring(0, 2))
      const mm = parseInt(item.lot_number.substring(2, 4)) - 1
      const dd = parseInt(item.lot_number.substring(4, 6))
      const sl = item.products?.shelf_life_months || defaultSL
      const expiry = new Date(2000 + yy, mm, dd)
      expiry.setMonth(expiry.getMonth() + sl)
      const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000)
      return {
        product: item.products?.product_name,
        warehouse: item.warehouses?.name,
        lot: item.lot_number,
        quantity: item.quantity,
        days_left: daysLeft,
        status: daysLeft <= 0 ? '만료' : '임박'
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }).sort((a: any, b: any) => a.days_left - b.days_left)

    return JSON.stringify(result)
  }

  if (name === 'get_outbound_summary') {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    const { data: txData } = await supabase
      .from('transactions')
      .select('quantity, channel, created_at, products(product_name)')
      .eq('company_id', companyId)
      .eq('type', '출고')
      .gte('created_at', monthStart.toISOString())

    const byProduct: Record<string, number> = {}
    const byChannel: Record<string, number> = {}
    let total = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(txData || []).forEach((t: any) => {
      const p = t.products?.product_name || '기타'
      const ch = t.channel || '기타'
      byProduct[p] = (byProduct[p] || 0) + t.quantity
      byChannel[ch] = (byChannel[ch] || 0) + t.quantity
      total += t.quantity
    })

    return JSON.stringify({
      month: `${today.getFullYear()}년 ${today.getMonth() + 1}월`,
      total_outbound: total,
      by_product: Object.entries(byProduct).sort((a, b) => b[1] - a[1]).map(([name, qty]) => ({ name, qty })),
      by_channel: Object.entries(byChannel).sort((a, b) => b[1] - a[1]).map(([name, qty]) => ({ name, qty }))
    })
  }

  if (name === 'get_order_recommendations') {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    const daysElapsed = Math.max(1, today.getDate())
    const [{ data: inventory }, { data: txData }] = await Promise.all([
      supabase.from('inventory').select('quantity, products(product_name)').eq('company_id', companyId).gt('quantity', 0),
      supabase.from('transactions').select('quantity, products(product_name)').eq('company_id', companyId).eq('type', '출고').gte('created_at', monthStart.toISOString())
    ])
    const stockByProduct: Record<string, number> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(inventory || []).forEach((i: any) => {
      const n = i.products?.product_name || '기타'
      stockByProduct[n] = (stockByProduct[n] || 0) + i.quantity
    })
    const outboundByProduct: Record<string, number> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(txData || []).forEach((t: any) => {
      const n = t.products?.product_name || '기타'
      outboundByProduct[n] = (outboundByProduct[n] || 0) + t.quantity
    })
    const recommendations = Object.entries(outboundByProduct)
      .map(([name, outbound]) => {
        const stock = stockByProduct[name] || 0
        const dailyRate = outbound / daysElapsed
        const daysLeft = dailyRate > 0 ? Math.floor(stock / dailyRate) : 999
        return { product: name, current_stock: stock, monthly_outbound: outbound, daily_rate: Math.round(dailyRate * 10) / 10, estimated_days_left: daysLeft, needs_order: daysLeft < 30 }
      })
      .filter(r => r.needs_order)
      .sort((a, b) => a.estimated_days_left - b.estimated_days_left)
    return JSON.stringify(recommendations.length > 0 ? recommendations : '발주 필요 제품 없음 (모든 제품 30일 이상 재고 여유)')
  }

  if (name === 'send_email_to_manager') {
    const { subject, content } = args

    // 본사 담당자 이메일 조회
    const { data: managers } = await supabase
      .from('profiles')
      .select('email, name')
      .eq('company_id', companyId)
      .eq('role', '본사')

    if (!managers || managers.length === 0) {
      return JSON.stringify({ success: false, reason: '본사 담당자 계정이 없습니다.' })
    }

    // 마크다운 → HTML 간단 변환
    const contentHtml = content
      .replace(/### (.+)/g, '<h3 style="color:#1e40af;margin:16px 0 8px;">$1</h3>')
      .replace(/## (.+)/g, '<h2 style="color:#1e40af;margin:20px 0 8px;">$1</h2>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/→ 권고: (.+)/g, '<p style="color:#d97706;font-weight:500;margin:4px 0 4px 12px;">→ 권고: $1</p>')
      .replace(/^- (.+)/gm, '<li style="margin:4px 0;">$1</li>')
      .replace(/\n/g, '<br/>')

    const html = `
      <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <div style="background:#1e40af;padding:24px 32px;border-radius:12px 12px 0 0;">
          <h1 style="margin:0;color:white;font-size:20px;">재고관리 AI</h1>
          <p style="margin:4px 0 0;color:#bfdbfe;font-size:13px;">재고 현황 리포트</p>
        </div>
        <div style="background:white;padding:28px 32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
          <div style="line-height:1.7;font-size:14px;">
            ${contentHtml}
          </div>
          <div style="margin-top:24px;padding:16px;background:#f8fafc;border-radius:8px;font-size:12px;color:#6b7280;text-align:center;">
            재고관리 AI 시스템에서 자동 발송된 메일입니다.
          </div>
        </div>
      </div>`

    // Resend 무료플랜: Gmail +alias 제거 (yehyun+ceo@gmail.com → yehyun@gmail.com)
    const recipients = managers.map(m =>
      m.email.replace(/(\+[^@]+)(@gmail\.com)$/, '$2')
    )
    const { error: emailError } = await resend.emails.send({
      from: '재고관리 AI <notify@attude.uk>',
      to: recipients,
      subject: subject || '[재고관리 AI] 재고 현황 리포트',
      html
    })

    if (emailError) {
      console.error('📧 본사 이메일 발송 실패:', emailError)
      return JSON.stringify({ success: false, reason: emailError.message })
    }

    return JSON.stringify({ success: true, recipients, subject })
  }

  if (name === 'get_today_transactions') {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const { data } = await supabase
      .from('transactions')
      .select('type, quantity, channel, note, created_at, products(product_name), warehouses(name)')
      .eq('company_id', companyId)
      .gte('created_at', todayStart.toISOString())
      .order('created_at', { ascending: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (data || []).map((t: any) => ({
      type: t.type,
      product: t.products?.product_name,
      warehouse: t.warehouses?.name,
      quantity: t.quantity,
      channel: t.channel,
      time: new Date(t.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    }))
    return JSON.stringify(result)
  }

  return '{}'
}

// ── POST 핸들러 ─────────────────────────────────────────────
export async function POST(request: Request) {
  try {
    const { message, history, company_id } = await request.json()

    if (!company_id) {
      return NextResponse.json({ action: '답변', message: '로그인 정보가 없습니다.' })
    }

    const now = new Date()
    const todayStr = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`
    const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const todayLot = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-01`

    const { data: warehouseList } = await getSupabaseAdmin()
      .from('warehouses')
      .select('name')
      .eq('company_id', company_id)
    const warehouseNames = (warehouseList || []).map((w: { name: string }) => w.name).join(', ')

    const { data: channelList } = await getSupabaseAdmin()
      .from('channels')
      .select('name')
      .eq('company_id', company_id)
    const channelNames = (channelList || []).map((c: { name: string }) => c.name).join(', ')

    const systemPrompt = `당신은 재고관리 AI 어시스턴트입니다. 오늘: ${todayStr}

## 도구 활용 원칙
- 출고 요청 → get_inventory tool 1회 호출 (product_name에 사용자 키워드 전달) → 결과 수신 즉시 action JSON 반환 (tool 재호출 금지)
- 입고 요청 → tool 호출 없이 바로 action JSON 반환
- 재고 조회, 유통기한, 출고 현황, 발주 분석 등 정보성 질문 → 적절한 tool 호출 후 답변
- 사용자가 "본사에 보내줘", "관리자에게 전달해줘", "위에 보고해줘", "이메일 발송" 등 요청 시 → 이메일 주소 절대 묻지 말고 즉시 send_email_to_manager 호출 (수신자는 tool이 DB에서 자동으로 찾음)
- 이메일 발송 시 사용자가 원하는 내용(일부만, 특정 섹션, 추가 코멘트 포함 등)을 정확히 반영해서 content 구성
- 이메일 내용은 단순 복붙이 아니라 사용자 지시대로 편집해서 보낼 것
- 확인/허락 요청 절대 금지 — 요청이 명확하면 바로 실행

## 응답 형식 (항상 JSON)

### 재고 변동 확정 시
{
  "action": "입고" | "출고",
  "product_name": "정확한 전체 제품명",
  "quantity": 숫자,
  "warehouse": "출발 창고명",
  "channel": "채널명 (외부출고시)",
  "date": "YYYY-MM-DD (날짜 지정시)",
  "lot_number": "YYMMDD-01 (입고시 필수)",
  "sub_type": "판매" | "내부사용" | "폐기" (출고 시 필수),
  "internal_use_reason": "샘플" | "협찬" (sub_type이 내부사용일 때 필수 — 딱 이 2개 값만 허용, 그 외 값 금지),
  "internal_use_recipient": "수령자 이름 (sub_type이 내부사용일 때 필수, 사용자가 말한 이름 그대로)",
  "message": "사용자에게 보여줄 메시지"
}

### 서로 다른 품목을 한 번에 출고할 때 (예: "쿠션100개+립밤100개 자사몰 출고")
product_name/quantity 단수 필드 대신 items 배열을 쓸 것. 이 경우 get_inventory tool 호출하지 말고 바로 반환(재고 확인은 프론트가 함).
{
  "action": "출고",
  "items": [ { "product_name": "정확한 전체 제품명", "quantity": 숫자 }, ... ],
  "warehouse": "창고명 (창고가 여러 개일 때만 필요)",
  "channel": "채널명 (외부출고시)",
  "date": "YYYY-MM-DD (날짜 지정시)",
  "sub_type": "판매" | "내부사용" | "폐기" (필수),
  "internal_use_reason": "샘플" | "협찬" (sub_type이 내부사용일 때 필수 — 딱 이 2개 값만 허용),
  "internal_use_recipient": "수령자 이름 (sub_type이 내부사용일 때 필수)",
  "message": "사용자에게 보여줄 메시지"
}

### 조회/분석 답변 시
{"action": "답변", "message": "한국어 자연어 답변"}

### 추가 정보 필요 시
{"action": "질문", "message": "질문 내용"}

## 날짜 처리 규칙 (매우 중요)
- 기준일: 오늘은 ${todayStr}(ISO: ${todayISO})입니다. 상대 날짜는 반드시 이 기준일로 계산할 것
  예) "어제" → 기준일-1일 / "내일" → 기준일+1일 / "3/27", "7월 5일" 등 → 기준일과 같은 연도로 변환
- 사용자가 "오늘"이라고 명시적으로 말한 경우에만 date: "${todayISO}" 반환
- ★★ 사용자가 날짜/시점을 전혀 언급하지 않았으면 date 필드를 절대 채우지 말고 완전히 생략할 것.
  기준일을 알고 있다고 해서 임의로 오늘 날짜를 채워 넣지 말 것 (date가 있으면 "사용자가 특정 시점을 지정했다"는
  뜻으로 해석되어 처리 시각이 달라짐 — 아무 말도 안 했는데 채우면 실제 처리 시각과 어긋나는 문제가 생김)

## 입고 처리 규칙 (매우 중요)
- 사용자가 창고명을 언급하면 → warehouse 그대로 사용
- 창고명을 언급하지 않았을 때 → action:"질문"으로 반드시 물어볼 것:
  "어느 창고로 입고할까요? (${warehouseNames})"
- 창고 모름/미지정 상태로 절대 action:"입고" 반환 금지
- lot_number는 사용자가 지정하지 않으면 오늘 날짜 기본값 사용 (물어볼 필요 없음)

## 출고 처리 규칙 (매우 중요)
- ★ 서로 다른 품목이 2개 이상 언급되면(예: "쿠션100+립밤100") → get_inventory 호출하지 말고 위 "서로 다른 품목을 한 번에 출고할 때" 형식(items 배열)으로 바로 반환. 품목 하나만 처리하고 나머지를 누락하는 것 절대 금지.
- 품목이 1개일 때만 아래 단일 품목 흐름을 따름:
- 출고 요청 시 → get_inventory tool 1회만 호출 (product_name에 사용자가 말한 키워드 그대로 전달)
  예) "핸드로션 30개 출고" → product_name:"핸드로션" / "세럼 200개 출고" → product_name:"세럼"
- get_inventory 결과에서 창고별 수량 합산 → warehouse는 수량이 가장 많은 창고 사용
- ★ get_inventory 결과를 받은 즉시 tool 재호출 없이 반드시 JSON으로 최종 응답
- 가용 재고 >= 요청 수량 → 즉시 action:"출고" JSON 반환
- 가용 재고 < 요청 수량 → action:"질문"으로 "현재 가용 재고는 N개입니다. N개로 출고할까요?" 안내
- 등록된 채널: ${channelNames || '(등록된 채널 없음)'}
- 사용자가 채널/목적지를 언급하면, 오타·줄임말이어도(예: "올영", "올리부영" → "올리브영") **위 등록된 채널 목록 중 가장 가까운 정확한 이름**으로 channel을 채울 것 — 목록에 없는 이름을 임의로 지어내지 말 것
  예) "올영 출고" → channel:"올리브영" (목록에 "올리브영"이 있을 때)
- 사용자가 말한 채널이 등록된 목록 중 **어디에도 뚜렷하게 대응되지 않으면** → action:"질문"으로 "등록된 채널 중 어디인가요? (${channelNames})" 안내 (임의로 비슷한 값 만들어내지 말 것)
- 등록된 채널 목록에 없는 임의 채널값 절대 금지

## 출고 사유 판단 (딱 한 번만 확인 — 매우 중요, 무사유 반출 차단)
action:"출고"는 반드시 sub_type("판매"|"내부사용"|"폐기")을 포함해야 함. 아래 순서로 딱 한 번만 판단하고, 애매하면 바로 질문으로 끝낼 것(다른 질문과 섞지 말 것):
1. channel이 있으면 → sub_type:"판매" (더 물어볼 필요 없음, 바로 진행)
2. "폐기"/"버림"/"불량 처리" 언급 → sub_type:"폐기" (더 물어볼 필요 없음, 바로 진행)
3. "내부사용"/"내부반출"/"반출"/"사내"/"사무실로"/"직원 지급"/"협찬"/"테스트용"/"테스트"/"샘플"/"샘플출고"/"샘플로 나감" 언급 → sub_type:"내부사용"
   - internal_use_reason은 딱 "샘플" 또는 "협찬" 둘 중 하나만 가능(그 외 값 절대 금지). "테스트"라고 말해도 internal_use_reason은 "샘플"로 매핑할 것(테스트는 샘플 카테고리에 포함됨). "협찬"이라고 명시했을 때만 "협찬"
   - internal_use_reason과 internal_use_recipient(수령자 이름)까지 둘 다 있어야 action:"출고" 반환. 없으면 action:"질문"으로 "내부사용 세부사유(샘플/협찬)와 수령자를 알려주세요"만 묻고 끝낼 것
4. 위 어디에도 해당 안 되면(채널·내부사용·폐기 표현이 전혀 없으면) → action:"질문"으로 딱 이거 하나만 물을 것: "판매(어느 채널인가요? ${channelNames}), 내부사용(사내 반출), 폐기 중 어느 경우인가요?"
★ 재고 수량 확인·창고 선택 등 다른 이유로 질문하지 말 것 — sub_type 판단은 재고 조회와 무관하게 사용자 문장만으로 즉시 정해짐

## 제품/창고 선택 규칙 (매우 중요)
- 입출고 action을 반환할 때 절대로 제품 선택 질문하지 말 것
- product_name은 사용자가 말한 키워드 그대로 반환 (예: "깐풍기", "바람떡")
- 복수 제품 매칭/창고 선택은 프론트엔드가 자동 처리하므로 API에서 물어보지 말 것
- get_inventory나 get_products로 여러 제품이 나와도 그냥 action:"출고" 등으로 반환
- 채널과 창고 정보만 확인되면 바로 action 반환

## 핵심 규칙
- 오늘 날짜: ${todayISO}, 기본 로트번호: ${todayLot}
- 입고 시 lot_number 항상 포함
- 모든 응답은 반드시 JSON (설명 텍스트 절대 금지, JSON만 반환)
- tool 실행 결과를 받은 후에도 반드시 JSON 형식으로 최종 응답할 것
- "출고를 진행하겠습니다", "잠시만 기다려주세요" 같은 확인/예고 텍스트 절대 금지
- action이 결정되면 바로 JSON 반환, 중간 설명 없음`

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...(history || []).map((h: { role: string; content: string }) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content
      })),
      { role: 'user', content: message }
    ]

    // ── Tool Use 루프 ──────────────────────────────────────
    const MAX_ROUNDS = 8
    let lastToolSig = ''
    let dupCount = 0
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.1,
      })

      const assistantMsg = completion.choices[0].message
      messages.push(assistantMsg)


      // 도구 호출 없음 → 최종 응답
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        const content = assistantMsg.content || '{}'
        try {
          // JSON 블록 추출 (```json ... ``` 또는 { ... } 형태).
          // 뒤쪽 { ... } 폴백은 반드시 탐욕적(greedy)이어야 함 — items 배열처럼 중첩 객체가 있으면
          // 비탐욕적 매칭은 제일 안쪽의 첫 "}"에서 끊겨 최상위 JSON이 잘린 채로 파싱 시도하게 됨.
          const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) || content.match(/(\{[\s\S]*\})/)
          const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content
          const parsed = JSON.parse(jsonStr.trim())
          if (!parsed.action) {
            return NextResponse.json({ action: '답변', message: parsed.message || content })
          }
          return NextResponse.json(parsed)
        } catch {
          // JSON 파싱 실패 → 메시지에서 action 키워드 감지
          if (content.includes('입고') || content.includes('출고')) {
            // AI가 텍스트로 확인 메시지만 보낸 경우 — 다음 라운드 강제
            messages.push({ role: 'user', content: '반드시 JSON 형식으로만 응답하세요. 텍스트 설명 없이 JSON만.' })
            continue
          }
          return NextResponse.json({ action: '답변', message: content })
        }
      }

      // 도구 실행
      for (const toolCall of assistantMsg.tool_calls) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tc = toolCall as any
        const args = JSON.parse(tc.function?.arguments || '{}')
        const toolName = tc.function?.name || ''

        // 연속 중복 tool call 감지 — 같은 호출 3번째면 루프 탈출
        const sig = `${toolName}:${JSON.stringify(args)}`
        if (sig === lastToolSig) {
          dupCount++
          if (dupCount >= 2) {
            return NextResponse.json({ action: '질문', message: '처리가 반복되고 있습니다. 요청을 다시 입력해 주세요.' })
          }
        } else {
          lastToolSig = sig
          dupCount = 0
        }

        const result = await executeTool(toolName, args, company_id)
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        })
      }
    }

    // 마지막 assistant 메시지 내용이 있으면 그걸 답변으로
    const lastMsg = messages.filter(m => m.role === 'assistant').pop()
    const lastContent = typeof lastMsg?.content === 'string' ? lastMsg.content : ''
    return NextResponse.json({ action: '답변', message: lastContent || '처리 중 문제가 발생했습니다. 다시 시도해주세요.' })

  } catch (error) {
    console.error('Chat API 에러:', error)
    return NextResponse.json({ action: '답변', message: 'AI 처리 중 오류가 발생했습니다.' }, { status: 500 })
  }
}
