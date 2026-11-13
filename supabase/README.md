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
