-- 창고 역할은 결재 직급(관리팀원/관리책임자/대표) 개념이 적용되지 않으므로 '담당자' 단일값 추가.
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table profiles drop constraint if exists profiles_position_check;
alter table profiles add constraint profiles_position_check
  check (position in ('관리팀원','관리책임자','대표','담당자'));
