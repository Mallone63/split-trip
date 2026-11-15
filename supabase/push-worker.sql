-- Run after migration, Edge Function deployment and creating Vault secrets
-- split_trip_push_url / split_trip_push_dispatch_secret. Never store values here.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
create or replace function public.wake_push_worker() returns void
language plpgsql security definer set search_path = '' as $$
declare worker_url text; worker_secret text;
begin
  if not exists(select 1 from public.push_jobs where status in ('pending','sending') and available_at<=now() and attempts<8) then return; end if;
  select decrypted_secret into worker_url from vault.decrypted_secrets where name='split_trip_push_url';
  select decrypted_secret into worker_secret from vault.decrypted_secrets where name='split_trip_push_dispatch_secret';
  if worker_url is null or worker_secret is null then return; end if;
  perform net.http_post(url:=worker_url,headers:=jsonb_build_object('Content-Type','application/json','x-push-secret',worker_secret),body:='{}'::jsonb,timeout_milliseconds:=30000);
exception when others then
  -- Saving a financial record must not depend on an HTTP wakeup. Cron retries.
  raise warning 'Push wakeup failed; retry is scheduled';
end $$;
revoke all on function public.wake_push_worker() from public,anon,authenticated;
create or replace function public.wake_push_worker_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin perform public.wake_push_worker();return null;end $$;
revoke all on function public.wake_push_worker_trigger() from public,anon,authenticated;
create trigger wake_push_worker after insert on public.push_jobs for each statement execute function public.wake_push_worker_trigger();
select cron.schedule('split-trip-push-retry','* * * * *',$job$select public.wake_push_worker();$job$);
select cron.schedule('split-trip-push-cleanup','17 3 * * *',$job$
  update public.push_jobs set status='failed',last_error='expired' where status in ('pending','sending') and (attempts>=8 or created_at<now()-interval '24 hours');
  delete from public.push_jobs where created_at<now()-interval '7 days';
  delete from public.push_reminders where sent_at<now()-interval '7 days';
$job$);
