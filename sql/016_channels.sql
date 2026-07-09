-- 출고 채널 목록 (자사몰/올리브영 등) — 자유 텍스트 대신 등록된 목록에서 선택하게 해서
-- 출고지시서 채널명과 실제 출고 등록 채널명이 안 맞는 문제(대사 매칭 실패)를 방지.
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

create table channels (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);
create index idx_channels_company on channels(company_id);

-- 이미 RLS를 켠 다른 회사단위 테이블들과 동일한 정책 (auth_company_id()는 sql/015에서 만든 헬퍼 함수)
alter table channels enable row level security;
create policy "channels_company" on channels
for all using (company_id = auth_company_id())
with check (company_id = auth_company_id());
