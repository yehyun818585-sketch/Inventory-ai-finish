-- 내부사용 반출 세부사유를 샘플(테스트)/협찬 2개로 단순화하고,
-- 샘플(테스트)은 등록된 사용자를 수령자로 지정해서 본인만 수령확인할 수 있게 함
-- (결재 자기승인 차단과 같은 원리 — 반출 기록자와 수령 확인자가 분리돼야 함).
-- 협찬은 외부 대상(로그인 계정 없음)이라 기존처럼 자유 텍스트 + 확인 절차 없이 유지.
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table transactions add column internal_use_category text check (internal_use_category in ('샘플', '협찬'));
alter table transactions add column internal_use_recipient_user_id uuid references profiles(id);
alter table transactions add column internal_use_recipient_name text;
alter table transactions add column internal_use_confirmed_at timestamptz;

-- 수령확인은 지정된 수령자 본인만 할 수 있도록 DB 트리거로 강제 (화면 제한만으로는 API 직접 호출로 우회 가능)
create or replace function enforce_internal_use_self_confirm()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.internal_use_confirmed_at is distinct from old.internal_use_confirmed_at
     and new.internal_use_confirmed_at is not null then
    if new.internal_use_recipient_user_id is null or new.internal_use_recipient_user_id != auth.uid() then
      raise exception '본인만 수령확인을 할 수 있습니다.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_internal_use_self_confirm on transactions;
create trigger trg_internal_use_self_confirm
before update on transactions
for each row execute function enforce_internal_use_self_confirm();
