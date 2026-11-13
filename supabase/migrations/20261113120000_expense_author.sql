-- Apply before deploying clients that write created_by_member_id.
-- Existing expenses deliberately retain NULL: payer_id does not identify the author.
begin;

alter table public.expenses
  add column created_by_member_id uuid
  references public.members (id) on delete set null;

-- Refresh the PostgREST schema cache after commit.
notify pgrst, 'reload schema';

commit;
