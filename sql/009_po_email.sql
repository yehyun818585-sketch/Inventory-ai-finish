-- 발주서 이메일 발송 (거래처 담당자에게)
-- Supabase 대시보드 SQL Editor에서 직접 실행하세요.

alter table companies add column default_po_email text; -- 발주서 발송 기본 수신처(회사 설정에서 지정)

alter table approval_documents add column supplier_email text;  -- 이 문서 발송 시 실제 사용한(또는 사용할) 수신처
alter table approval_documents add column po_sent_at timestamptz; -- 발주서 발송 시각
alter table approval_documents add column po_sent_to text;        -- 발주서 발송 당시 수신처(기록용)
