import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runReconciliationAlertForCompany } from '@/lib/reconciliationAlert'

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Vercel Cron이 매일 자동으로 호출하는 엔드포인트 (앱을 아무도 안 열어도 실행됨).
// 회사별로 순회하며 기존 대사 알림 로직(오늘 마감/기한초과/에스컬레이션/미매칭)을 그대로 재사용한다.
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()
  const { data: companies } = await supabase.from('companies').select('id')

  const results = []
  for (const company of companies || []) {
    try {
      const result = await runReconciliationAlertForCompany(company.id, supabase)
      results.push({ company_id: company.id, ...result })
    } catch (error) {
      console.error(`cron 대사 알림 실패 (company_id=${company.id}):`, error)
      results.push({ company_id: company.id, error: String(error) })
    }
  }

  return NextResponse.json({ ok: true, checked: results.length, results })
}
