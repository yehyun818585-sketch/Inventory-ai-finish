-- 출고 전용 유예일수(발주보다 짧게, 회사가 통제하는 확정 출고일이라 유예가 거의 필요없음)
-- + 배송 마감시간(하루 1회 발송 정책 기준, 예: 15:00)
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table companies add column outbound_grace_days int not null default 0;
alter table companies add column shipping_cutoff_time time not null default '15:00';
