-- 출고지시서 전용: 채널이 보낸 발주/주문 근거서류(엑셀·PDF) 첨부 경로.
-- 자사몰(카페24 등): 신규주문 배치 엑셀 원본. 올리브영 등: 벤더포털 발주서 원본.
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table approval_documents add column channel_order_file_url text;
