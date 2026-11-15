#!/usr/bin/env python3
"""Deploy only Split Trip's push infrastructure. Token is read from hidden stdin.
Run tests/build first. --check performs read-only checks; --bundle-only validates
Edge Function compilation without deployment. No trip financial data is changed.
"""
import argparse, getpass, json, pathlib, subprocess, urllib.request, urllib.error, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--project-ref',required=True);p.add_argument('--app-url',required=True);p.add_argument('--check',action='store_true');p.add_argument('--bundle-only',action='store_true');args=p.parse_args()
key=getpass.getpass('Supabase access token (hidden): ')
BASE='https://api.supabase.com/v1/projects/'+args.project_ref

def api(path,method='GET',data=None,content_type='application/json'):
    payload=json.dumps(data).encode() if data is not None and content_type=='application/json' else data
    req=urllib.request.Request(BASE+path,method=method,data=payload,headers={'Authorization':'Bearer '+key,'Content-Type':content_type})
    try:
        with urllib.request.urlopen(req,timeout=90) as r:
            raw=r.read();return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        # SQL errors can contain secrets: report only an HTTP status, never raw bodies.
        raise RuntimeError(f'Supabase {path.split("?")[0]} returned HTTP {e.code}') from None

def sql(query):return api('/database/query','POST',{'query':query})
def quote(value):return "'"+str(value).replace("'","''")+"'"

def deploy(bundle_only=False):
    boundary='split-trip-'+uuid.uuid4().hex
    metadata=json.dumps({'name':'push','entrypoint_path':'index.js','verify_jwt':False})
    body=(f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="index.js"\r\nContent-Type: application/javascript\r\n\r\n').encode()
    body+=(ROOT/'supabase/functions/push/bundle.js').read_bytes()+f'\r\n--{boundary}--\r\n'.encode()
    result=api('/functions/deploy?slug=push'+('&bundleOnly=1' if bundle_only else ''),'POST',body,'multipart/form-data; boundary='+boundary)
    print(json.dumps({'function_bundled' if bundle_only else 'function_deployed':True,'status':result.get('status'),'version':result.get('version')}),flush=True)

if args.check:
    result=sql("select to_regclass('public.push_subscriptions') is not null as subscriptions_ready, to_regclass('public.push_jobs') is not null as queue_ready")
    print(json.dumps({'schema':result,'functions':[{'slug':f['slug'],'status':f['status']} for f in api('/functions')]}))
    raise SystemExit
if args.bundle_only:
    deploy(True);raise SystemExit

# The only DDL is the checked-in migration. All financial tables retain their rows.
ready=sql("select to_regclass('public.push_jobs') is not null as ready")[0]['ready']
if not ready:
    sql((ROOT/'supabase/migrations/20261115070000_web_push.sql').read_text())
    print('Push migration applied',flush=True)
# Keep stable keys in Vault for re-runs and recovery; never print or persist locally.
values=sql("select name,decrypted_secret from vault.decrypted_secrets where name in ('split_trip_vapid_public','split_trip_vapid_private','split_trip_push_dispatch_secret')")
secrets={r['name']:r['decrypted_secret'] for r in values}
if not secrets:
    vapid=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import webpush from 'web-push';process.stdout.write(JSON.stringify(webpush.generateVAPIDKeys()));"],cwd=ROOT,text=True))
    secrets={'split_trip_vapid_public':vapid['publicKey'],'split_trip_vapid_private':vapid['privateKey'],'split_trip_push_dispatch_secret':uuid.uuid4().hex+uuid.uuid4().hex}
    for name,value in secrets.items():sql('select vault.create_secret('+quote(value)+','+quote(name)+')')
elif len(secrets)!=3:raise RuntimeError('Incomplete Vault configuration; do not rotate existing VAPID keys automatically')
worker_url='https://'+args.project_ref+'.supabase.co/functions/v1/push/dispatch'
existing=sql("select id from vault.secrets where name='split_trip_push_url'")
if existing:sql('select vault.update_secret('+quote(existing[0]['id'])+'::uuid,'+quote(worker_url)+')')
else:sql('select vault.create_secret('+quote(worker_url)+",'split_trip_push_url')")
api('/secrets','POST',[{'name':name,'value':value} for name,value in {
  'VAPID_PUBLIC_KEY':secrets['split_trip_vapid_public'],'VAPID_PRIVATE_KEY':secrets['split_trip_vapid_private'],
  'VAPID_SUBJECT':args.app_url,'PUSH_APP_URL':args.app_url,'PUSH_DISPATCH_SECRET':secrets['split_trip_push_dispatch_secret'],
}.items()])
print('Push runtime configured',flush=True)
deploy()
# Runtime smoke checks use only configuration and an EMPTY outbox.
# Do not send a test push or insert a subscription/expense.
with urllib.request.urlopen('https://'+args.project_ref+'.supabase.co/functions/v1/push/config',timeout=30) as r:
    config=json.load(r)
if config.get('publicKey')!=secrets['split_trip_vapid_public']:raise RuntimeError('Public key verification failed')
if not sql("select exists(select 1 from pg_trigger where tgname='wake_push_worker') as ready")[0]['ready']:
    sql((ROOT/'supabase/push-worker.sql').read_text())
print('Push runtime and scheduler ready',flush=True)
print(json.dumps(sql("select (select count(*) from public.push_subscriptions) as subscriptions,(select count(*) from public.push_jobs) as jobs")))
