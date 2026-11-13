# Split Trip API / MCP

An optional Node 22+ process, separate from the static PWA. It uses the existing
`split.ts`, `fx.ts` and currency rules with the same database as the app.
Both REST and MCP call the same service and are scoped to one configured trip.
No editing, deletion, settlement or wallet tools are exposed.

## Production: ChatGPT Sites

The connected production **Split Trip** plugin is hosted on **ChatGPT Sites**.
This was verified on 2026-11-13; the Node process described below is an alternative
runtime, not the currently deployed hosting arrangement.

| Setting | Value |
| --- | --- |
| Site | https://split-trip-mcp.candyhedgehog1.chatgpt.site |
| Project ID | `appgprj_6af15385ba5481919d6b6007228d64f1` |
| MCP endpoint | `https://split-trip-mcp.candyhedgehog1.chatgpt.site/mcp` |
| Plugin ID | `plugin_asdk_app_sites_fab813e503e881918706887edc3f9485` |
| Audience | Owner-private; preserve it when updating |
| Runtime | Cloudflare Worker, `worker/index.ts` in the Site's source repository |

The Site source is a separate Sites-managed Git repository. Resolve it using
`get_site` and `create_source_repository_write_credential` for the project ID
above; never create another Site for an update. Its `server/service.ts` and money
helpers come from this repository; `worker/index.ts` supplies Sites authentication,
MCP discovery, tool schemas/descriptions and REST routing. `server/mcp.ts` and
`server/http.ts` are Node transports, not the production Worker entry point.

To ship MCP changes, synchronize the affected service/helpers and the Worker's
tool definitions/instructions, run the Site's tests/build, then publish that
Site's committed source through Sites. Republishing refreshes the connected
plugin's tools. Verify with a read-only call. GitHub merges and Pages deployment
alone do not update the MCP. There is no separate VPS restart to request.

Production variables `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `TRIP_ID` are managed
in Sites runtime configuration. Keep values and credentials out of source/docs.

## Run

From the repository root:

```sh
npm ci
cp server/.env.example server/.env
# Fill in Supabase URL, anon key, trip UUID and a random API_TOKEN.
# The trip UUID is the ?trip= value from the invitation link.
npm run server
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` are the same project settings used by the
PWA (without the `VITE_` prefix). Use the anon key, not a service-role key.
`API_TOKEN` is a separate server token: generate it with `openssl rand -hex 32`.
Keep `server/.env` private; it is gitignored. Never put API_TOKEN in a VITE variable.

Default address: `127.0.0.1:3001`. Deploy the process separately from GitHub
Pages. For a remote client use an HTTPS reverse proxy; set HOST appropriately
for that deployment (e.g. `0.0.0.0` in a container). Every endpoint requires
`Authorization: Bearer <API_TOKEN>`. Browser origins/CORS are not enabled.

This token protects **this service only**. Existing Supabase permissive RLS and
the app's invite-link model are unchanged. It does not restrict direct access
to Supabase or add per-user accounts. One process/token maps to one trip.

## REST

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/trip` | `{ trip, members }` |
| GET | `/api/expenses` | `{ expenses }`, latest 100 by spending/creation date |
| POST | `/api/expenses` | `{ expense, created }`, 201 on insert, 200 on replay |

Responses use the existing Supabase column names (`trip_id`, `amount`,
`fx_rate`, `base_amount`, etc.); `splits` keeps the existing camelCase fields.
All money amounts are **integer minor units**: 100 RUB = 10000, 100 JPY = 100.

### Expense kinds

Both REST and MCP accept `kind: "shared"` or `kind: "personal"`. Omitting `kind`
keeps the existing shared-expense behavior, so older clients continue to work.

| Kind | Required fields besides requestId, title, currency, spentAt | Optional fields |
| --- | --- | --- |
| `shared` (default) | `participantIds`, `paid` | `shares`, `fxRate` |
| `personal` | `memberId`, `amountMinor` | `fxRate` |

Both kinds also accept optional `createdByMemberId`: the known member entering
the record, independent of who paid or whose wallet the expense belongs to.
It must belong to this trip but need not be included in the split. Omit it when
unknown; the service does not guess an author. Retry with the same author and
requestId. Responses include `created_by_member_id` (nullable).

Before deploying this version of either client, apply
`supabase/migrations/20261113120000_expense_author.sql` to the existing database.
See `supabase/README.md` for rollout order and local migration checks.

For personal expenses, `memberId` is the identified member recording/paying the
expense (the app's “me”). The server includes that member and everyone with the
same non-null `unit`, splits the amount equally and records that member paying
the whole amount. A member without a wallet stays solo. This matches the app's
«Личная» mode: the expense appears in personal totals and history without
changing wallet-level debts. It is still visible to everyone in the trip.
No DB migration or new persisted flag is needed; the existing splits determine
whether an expense is personal to a wallet.

Do not send `participantIds`, `paid` or `shares` for personal expenses, or
`memberId` / `amountMinor` for shared expenses. Mixed or incomplete payloads
return 400; extra fields are not silently ignored.

Example shared POST body (substitute real member UUIDs from GET `/api/trip`):

```json
{
  "requestId": "cb515fce-9e50-4ef3-a7a2-fd3895a42740",
  "kind": "shared",
  "title": "Ужин",
  "currency": "JPY",
  "spentAt": "2026-11-09",
  "participantIds": [
    "ab7fc31f-20c7-4d10-a870-410f8f63d518",
    "0a0eb236-1269-493f-9c2b-af688f893062"
  ],
  "paid": [{ "memberId": "ab7fc31f-20c7-4d10-a870-410f8f63d518", "amountMinor": 12000 }]
}
```

Example personal POST body (the member's wallet is resolved on the server):

```json
{
  "requestId": "d5ea2d10-bf93-4b0b-828a-94f3b014c3eb",
  "kind": "personal",
  "title": "7-Eleven",
  "currency": "JPY",
  "spentAt": "2026-11-13",
  "memberId": "ab7fc31f-20c7-4d10-a870-410f8f63d518",
  "amountMinor": 4500
}
```

Save the body as `expense.json`, then:

```sh
curl http://127.0.0.1:3001/api/expenses \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @expense.json
```

- For shared expenses, `paid` can contain several payers; their sum is the expense total.
- For shared expenses, omit `shares` for the app's equal split. For exact shares supply
  `shares: [{ memberId, amountMinor }, ...]`; their total must equal total paid.
- Optional `fxRate` is the rate to the trip's base currency. If omitted, use the
  same live suggestion as the app. It is frozen when recorded, including retries.
- `spentAt` is an explicit local date. The caller resolves “today” in the user's
  timezone. No participant identity or timezone is inferred from the server.
- Generate a fresh UUID `requestId` per expense; keep the same UUID **and body**
  on retry after a timeout. It becomes the expense primary key, so concurrent
  retries cannot insert duplicates. Reusing it for a different expense returns
  409. The same expense with a fresh UUID is a new record.
- Personal retries are checked against the current wallet membership. If it has
  changed and would produce different splits, the retry returns 409 and leaves
  the saved expense untouched. Read the saved record; do not retry with a new UUID.
- Invalid input returns 400, invalid token 401, oversized body 413,
  unsupported content type 415, backend failure 502. Error bodies: `{ error }`.
  On 502 retry with the original requestId; the first write may have succeeded.

## MCP

Streamable HTTP endpoint: `https://your-api-host/mcp` (POST, stateless).
Tools: `get_trip`, `list_expenses`, `add_expense`. The last tool accepts either
POST body above. Resolve names and wallets once with `get_trip`, then reuse the
returned IDs for this configured trip in the same conversation. Refresh when
context is missing, membership changes, or the server rejects a stale ID. The
server still validates current membership on every write; it does not cache wallets.
A request for a personal expense uses `kind: "personal"` and the identified
requesting member. Shared expenses also need resolved payers and participants.

### Fast entry workflow

- Reuse established user defaults: today in the known user timezone and the
  established trip currency when omitted. Ask only about unresolved details;
  never invent an identity, shared participants or a timezone.
- With known IDs, a routine entry needs just **one tool call: `add_expense`**.
  Otherwise call `get_trip` once, then `add_expense`.
- Do not fetch history, search personal context, browse or inspect source code
  when the conversation already contains the data needed for the expense.
- Generate a request UUID locally. Duplicate retries are handled by that UUID,
  not by scanning history or comparing titles/amounts (identical purchases can
  be legitimate separate expenses).
- Treat the successful write response as confirmation and answer in one short
  sentence. No follow-up verification read is needed. An uncertain write must
  retry with the exact same UUID and body.

These rules are advertised in MCP initialization instructions and tool descriptions.
Clients with static descriptions must refresh those too. The server overlaps the
trip/member reads and requestId lookup, removing one sequential database wait
without weakening validation or duplicate protection. Model and network latency
still depend on the client and deployment.

Connect using an MCP client that can set the Authorization bearer header.
This process does **not** implement OAuth discovery/login. ChatGPT clients that
require OAuth for authenticated custom connectors need an OAuth gateway in
front of this endpoint; the static token is not a drop-in OAuth credential.
Dictation can supply text commands; live voice mode tool availability depends
on the client. Deploying the process does not automatically connect it to a chat.

For the connected production plugin, use the Sites update flow above. For a
separately self-hosted Node server, redeploy/restart that process. Publishing
GitHub Pages alone does not update either MCP. Refresh the client's tool definitions
so `add_expense` exposes `kind`, `memberId` and `amountMinor`; a cached shared-only
schema cannot call the new personal mode. If a gateway or plugin keeps its own
static tool schema, update that schema to match this server as well.

## Verify

`npm test` includes REST and MCP integration tests against an in-memory
Supabase HTTP boundary. `npm run build` also type-checks the server. Tests do
not write to a real trip. The existing Pages deployment still publishes only
the static `dist/` directory, not this server.
