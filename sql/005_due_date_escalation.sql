-- "즉시 강제" → "예정일+유예(α) 초과 시 미기록 알림+에스컬레이션" 전환
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table approval_documents add column expected_date date; -- 발주=납기예정일, 출고=출고예정일 (이동은 미사용)
alter table approval_documents add column stage1_alert_sent_at timestamptz; -- 1차(창고담당자) 알림 발송 시각
alter table approval_documents add column escalated_at timestamptz;        -- 승인자 에스컬레이션 발송 시각

alter table companies add column reconciliation_grace_days integer not null default 3; -- 유예(α), 회사별 설정 가능
