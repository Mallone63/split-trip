# Split Trip API / MCP

An optional Node 22+ process, separate from the static PWA. It uses the existing
`split.ts`, `fx.ts` and currency rules without changing the app or DB schema.
Both REST and MCP call the same service and are scoped to one configured trip.
No editing, deletion, settlement or wallet tools are exposed.

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

Example POST body (substitute real member UUIDs from GET `/api/trip`):

```json
{
  "requestId": "cb515fce-9e50-4ef3-a7a2-fd3895a42740",
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

Save the body as `expense.json`, then:

```sh
curl http://127.0.0.1:3001/api/expenses \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @expense.json
```

- `paid` can contain several payers; their sum is the expense total.
- Omit `shares` for the app's equal split. For exact shares supply
  `shares: [{ memberId, amountMinor }, ...]`; their total must equal total paid.
- Optional `fxRate` is the rate to the trip's base currency. If omitted, use the
  same live suggestion as the app. It is frozen when recorded, including retries.
- `spentAt` is an explicit local date. The caller resolves “today” in the user's
  timezone. No participant identity or timezone is inferred from the server.
- Generate a fresh UUID `requestId` per expense; keep the same UUID **and body**
  on retry after a timeout. It becomes the expense primary key, so concurrent
  retries cannot insert duplicates. Reusing it for a different expense returns
  409. The same expense with a fresh UUID is a new record.
- Invalid input returns 400, invalid token 401, oversized body 413,
  unsupported content type 415, backend failure 502. Error bodies: `{ error }`.
  On 502 retry with the original requestId; the first write may have succeeded.

## MCP

Streamable HTTP endpoint: `https://your-api-host/mcp` (POST, stateless).
Tools: `get_trip`, `list_expenses`, `add_expense`. The last tool accepts exactly
the POST body above. Read the trip first to resolve names, and ask when the
payer/currency/participants/date are unclear. Never guess a participant UUID.

Connect using an MCP client that can set the Authorization bearer header.
This process does **not** implement OAuth discovery/login. ChatGPT clients that
require OAuth for authenticated custom connectors need an OAuth gateway in
front of this endpoint; the static token is not a drop-in OAuth credential.
Dictation can supply text commands; live voice mode tool availability depends
on the client. Deploying the process does not automatically connect it to a chat.

## Verify

`npm test` includes REST and MCP integration tests against an in-memory
Supabase HTTP boundary. `npm run build` also type-checks the server. Tests do
not write to a real trip. The existing Pages deployment still publishes only
the static `dist/` directory, not this server.
