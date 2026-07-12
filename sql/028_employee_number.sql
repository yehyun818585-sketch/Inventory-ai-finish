-- 사용자 이름은 동명이인이 있을 수 있어(회사명과 같은 문제), 회사 내에서 사람을 확실히
-- 구분할 사번을 추가한다. AI 챗봇이 수령자 이름으로 등록된 사용자를 찾을 때 동명이인이
-- 여러 명이면 사번으로 되물어 확정하는 데 쓴다.
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table profiles add column if not exists employee_number text;

-- 같은 회사 안에서는 사번이 유일해야 함. 기존 계정은 사번이 비어있을 수 있어(nullable),
-- null은 유일성 검사에서 제외되는 부분 유니크 인덱스로 만든다.
create unique index if not exists idx_profiles_company_employee_number
  on profiles(company_id, employee_number) where employee_number is not null;
