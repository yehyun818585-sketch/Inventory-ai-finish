-- 입출고 실물기록(transactions)의 등록/삭제는 창고담당자(role='창고')만 가능하도록 제한.
-- 화면(버튼 숨김)뿐 아니라 DB(RLS)에서도 막아야 API를 직접 두드리는 우회를 막을 수 있음
-- (자기승인 차단 때와 같은 원칙 — sql/015_enable_rls.sql 참고).
-- 조회·수정(증빙 첨부 등)은 기존대로 회사 전체에 열어둔다.
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

create or replace function auth_role()
returns text
language sql
security definer
stable
as $$
  select role from profiles where id = auth.uid()
$$;

-- 최초 온보딩(app/onboarding/page.tsx, 초기 재고 실사입력)은 창고 역할이 아닌 관리자가 하는 경우도
-- 많아서, 본인 온보딩이 아직 안 끝난 상태라면 예외적으로 허용한다.
create or replace function auth_onboarding_completed()
returns boolean
language sql
security definer
stable
as $$
  select coalesce(onboarding_completed, false) from profiles where id = auth.uid()
$$;

drop policy if exists "transactions_company" on transactions;

create policy "transactions_select" on transactions
for select using (company_id = auth_company_id());

create policy "transactions_insert_warehouse_only" on transactions
for insert with check (
  company_id = auth_company_id()
  and (auth_role() = '창고' or auth_onboarding_completed() = false)
);

create policy "transactions_update" on transactions
for update using (company_id = auth_company_id()) with check (company_id = auth_company_id());

create policy "transactions_delete_warehouse_only" on transactions
for delete using (
  company_id = auth_company_id()
  and (auth_role() = '창고' or auth_onboarding_completed() = false)
);
