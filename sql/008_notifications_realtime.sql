-- notifications 테이블이 실시간 구독(postgres_changes) 대상에 포함되도록 발행에 추가
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter publication supabase_realtime add table notifications;
