-- 회원가입 "동일 회사명 있으면 합류" 로직이 회사명 문자열 일치만으로 남의 회사에 합류시켜주던
-- 구멍을 막는다. 이제 합류는 회사명이 아니라 이 초대코드로만 가능하다.
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table companies add column if not exists invite_code text;

-- 기존에 이미 만들어진 회사들도 코드가 있어야 합류 기능을 계속 쓸 수 있음
update companies set invite_code = upper(substr(md5(random()::text || id::text), 1, 8))
where invite_code is null;

alter table companies alter column invite_code set not null;
alter table companies add constraint companies_invite_code_unique unique (invite_code);
