-- 발주확인서 자동검증 실패("검토 필요") 상태를 문서에 남겨서 상세페이지에 빨간 배너로 보이게 함.
-- 지금까진 알림 메시지에만 남고 문서 자체엔 흔적이 없어서 알림을 놓치면 묻히는 문제가 있었음.
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table approval_documents add column po_confirmation_review_needed boolean not null default false;
alter table approval_documents add column po_confirmation_review_reason text;
