import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runReconciliationAlertForCompany } from '@/lib/reconciliationAlert'

function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: Request) {
  try {
    const { company_id } = await request.json()
    if (!company_id) return NextResponse.json({ error: 'company_id 필요' }, { status: 400 })

    const supabase = getSupabaseAdmin()
    const result = await runReconciliationAlertForCompany(company_id, supabase)
    return NextResponse.json(result)
  } catch (error) {
    console.error('check-reconciliation-alert 에러:', error)
    return NextResponse.json({ error: '서버 오류' }, { status: 500 })
  }
}
