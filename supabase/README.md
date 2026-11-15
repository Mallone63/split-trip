# Database changes

For a new database, use `schema.sql`. For an existing database, apply incremental
SQL from `migrations/` in filename order, once per migration. Do not rerun the
full schema or backfill authors from payers.

## Expense author rollout

1. Run `npm test` and `npm run build`. The SQL tests use in-memory PostgreSQL
   (PGlite), seed only synthetic data, apply the actual migration, and check
   existing rows, old-client inserts, nullable authors and the foreign key.
2. Apply `migrations/20261113120000_expense_author.sql` via the Supabase SQL editor
   or the deployment's migration runner. It adds one nullable foreign key in a
   transaction and requests a PostgREST schema-cache reload.
3. Deploy the separate ChatGPT Sites MCP after the migration is confirmed applied.
   The PWA can ship earlier: on a specific missing-author-column rejection, it
   saves the expense using the old schema. These expenses have no author metadata.
   Network errors and other failures are never retried through this fallback.

Existing expenses retain NULL. Old clients remain compatible after migration.
The app records the selected valid participant from «Управление»; MCP callers
send `createdByMemberId` explicitly when the author is known. This is a user's
selected identity, not an authenticated audit trail.

If a client release needs to be rolled back, keep the nullable column and roll
back the client only; removing the column would discard newly recorded authors.

## Web Push rollout

`20261115070000_web_push.sql` adds `expenses.silent`, optional settlement/transfer
actors, private subscriptions, an outbox and server-only RPCs. Apply it before
publishing either new client. It never broadcasts old records. `schema.sql`
contains the same definitions for fresh installations.

1. Run `npm test`, `npm run build`, `node scripts/build-push.mjs`.
2. Validate the Deno bundle without deploying:
   `python3 scripts/deploy-push.py --project-ref <ref> --app-url https://<host>/split-trip/ --bundle-only`.
3. Run that command without `--bundle-only` to apply the checked migration,
   generate stable VAPID keys in Vault, configure/deploy the `push` Edge Function,
   verify its config endpoint, and install `push-worker.sql` (pg_net + cron).
   The management token is entered on hidden stdin, never saved. Re-runs reuse
   keys; do not rotate VAPID keys while subscriptions exist.
4. Publish the PWA and update the separate Sites MCP service/tool descriptions.
   PWA configuration uses its existing Supabase URL/key; no additional frontend
   secret or build variable is needed. Keep the MCP owner-private.
5. On a real device, choose the participant and enable notifications in
   «Управление». iOS requires installation on the Home Screen. A first genuine
   opted-in delivery is the remaining device acceptance test; never create
   financial test records in the production trip.

Runtime variables: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
`PUSH_APP_URL`, `PUSH_DISPATCH_SECRET`, plus Supabase's standard URL/service key.
The service-role key and VAPID private key never reach the browser. Registration
and preference changes require a random per-installation secret; the database
stores its SHA-256 digest. Only the private dispatcher can read endpoints/jobs.
Only known HTTPS Apple/Google/Mozilla push endpoints are accepted.

The trip invite and selected «это вы» remain the existing trust model, **not an
account or verified identity**. Reminder authorization uses that selected member
and the current creditor wallet; receiving pushes yourself is not required to
remind someone else. Cooldown is shared across creditor/debtor wallets and all
currencies (24 hours). The debt is computed with the same money helpers as the
PWA, from a single complete database snapshot, and checked again before delivery.

Outbox events are created in the financial write transaction, for subscriptions
that exist at that time. The worker wakes after commit; cron retries once a minute.
It uses leased jobs, at most eight attempts, exponential backoff, a 24-hour
expiry (one hour for reminders), and removes 404/410 subscriptions. Delivery is
at-least-once: stable notification tags replace uncertain retries on the device,
but a push-service success is not a read receipt. Sent jobs are retained seven
days. Silent expenses never enqueue insert or deletion notifications. Payments,
conversions and undo notify both affected wallets; known actors are excluded.
Undo actors are unknown, so their notifications go to both sides. Expense
recipients have a positive share/payment, including legacy payers, excluding
zero-only placeholders. No event is sent to unrelated trip members.

Read-only checks: use `--check`. Inspect `push_jobs` status counts and cron run
results as an administrator; do not log endpoints, subscription keys or payloads.
To pause dispatch, unschedule `split-trip-push-retry` and disable the
`wake_push_worker` trigger. Roll back clients rather than dropping new columns
or private tables. Do not enable the reminder UI until its mockup is approved.
