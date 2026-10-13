begin;
-- Stop sending the event payment account to the public page from 2026-10-19 00:00 KST.
-- The function also holds sponsor details, so only the payment-account part is patched in place.
do $patch$
declare d text;
  o1 text:='''publicPaymentAccount'', jsonb_build_object(';
  n1 text:='''publicPaymentAccount'', case when now()>=timestamptz ''2026-10-19 00:00:00+09'' then ''{}''::jsonb else jsonb_build_object(';
  o2 text:='''participantFee'', 80000'||chr(10)||'    ),';
  n2 text:='''participantFee'', 80000'||chr(10)||'    ) end,';
begin
  d:=pg_get_functiondef('public.get_hanjogo_public_dashboard()'::regprocedure);
  if position(o1 in d)=0 or position(o2 in d)=0 then raise exception '공개 대시보드 함수가 예상과 다릅니다.'; end if;
  execute replace(replace(d,o1,n1),o2,n2);
end $patch$;
commit;
