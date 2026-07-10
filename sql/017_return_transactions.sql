-- 반품 입고: 근거 없는 반품 입고를 막기 위해 원 출고 건을 반드시 참조하게 함.
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table transactions add column return_of_transaction_id uuid references transactions(id);
