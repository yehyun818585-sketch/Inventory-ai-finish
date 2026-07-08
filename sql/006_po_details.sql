-- 발주품의서 개선: 거래처/발주번호/납기 확정 이원화/단가
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table approval_documents add column supplier_name text; -- 거래처명 (발주품의서 전용, 1개 OEM으로 시작)
alter table approval_documents add column order_number text;  -- 발주번호, 자동생성 (YYMMDD-NN)
alter table approval_documents add column confirmed_date date; -- 거래처가 실제 확정해준 납기일 (수동 입력, nullable)
alter table approval_documents add column confirmation_file_url text; -- 발주확인서 파일(선택 첨부, evidence 버킷 재사용)

alter table approval_document_items add column unit_price numeric; -- 비우면 제품 기본 unit_cost 사용
