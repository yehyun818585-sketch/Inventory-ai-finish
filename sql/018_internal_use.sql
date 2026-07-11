-- 월말 AI 리포트 확인 여부 추적 (내부사용 반출 통제 — 월말 확인 유도용)
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table companies add column monthly_report_confirmed_at timestamptz;
