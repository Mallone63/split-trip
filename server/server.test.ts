import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { suggestRate } from '../src/lib/fx';
import { createService } from './service';
import { createHttpServer } from './http';

vi.mock('../src/lib/fx', async (original) => ({
  ...await original<typeof import('../src/lib/fx')>(), suggestRate: vi.fn(async () => 1.5),
}));

const tripId = '10000000-0000-4000-8000-000000000000';
const alice = '20000000-0000-4000-8000-000000000000';
const bob = '30000000-0000-4000-8000-000000000000';
const requestId = '40000000-0000-4000-8000-000000000000';
const token = 'a'.repeat(64);
const input = {
  requestId, title: 'Ужин', currency: 'JPY', spentAt: '2026-11-09',
  participantIds: [bob, alice], paid: [{ memberId: alice, amountMinor: 101 }],
};

// Exercise the actual Supabase HTTP client against an in-memory PostgREST boundary.
function setup() {
  const rows: Record<string, unknown>[] = [];
  const calls: URL[] = [];
  let failInsert = false;
  const db = createClient('https://example.supabase.co', 'anon-key', {
    auth: { persistSession: false },
    global: { fetch: async (url, init) => {
      const parsed = new URL(String(url));
      calls.push(parsed);
      const table = parsed.pathname.split('/').pop();
      let body: unknown;
      let status = 200;
      if (table === 'trips') body = { id: tripId, name: 'Japan', base_currency: 'USD' };
      else if (table === 'members') body = [
        { id: alice, trip_id: tripId, name: 'Alice', unit: null },
        { id: bob, trip_id: tripId, name: 'Bob', unit: null },
      ];
      else if (init?.method === 'POST') {
        const row = JSON.parse(String(init.body));
        if (failInsert) { status = 503; body = { message: 'unavailable' }; }
        else if (rows.some(r => r.id === row.id)) {
          status = 409; body = { code: '23505', message: 'duplicate' };
        } else { rows.push(row); body = row; status = 201; }
      } else {
        const id = parsed.searchParams.get('id')?.slice(3);
        body = id ? rows.find(r => r.id === id) ?? null : rows;
      }
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  return { service: createService(db, tripId), rows, calls, fail: () => { failInsert = true; } };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()));
  vi.mocked(suggestRate).mockResolvedValue(1.5);
});

async function listen() {
  const fixture = setup();
  const server = createHttpServer(fixture.service, token);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init?: RequestInit) => fetch(base + path, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  return { ...fixture, base, request };
}

describe('expense service', () => {
  it('uses existing equal-split rounding, per-split FX and one-trip queries', async () => {
    vi.mocked(suggestRate).mockResolvedValue(0.0001);
    const { service, calls } = setup();
    const result = await service.addExpense(input);
    expect(result.created).toBe(true);
    expect(result.expense).toMatchObject({
      id: requestId, trip_id: tripId, payer_id: alice, amount: 101,
      // Per-split conversion gives 1 + 1 = 2, while converting the total gives 1.
      fx_rate: 0.0001, base_amount: 2,
      splits: [{ memberId: alice, amountMinor: 51, paidMinor: 101 }, { memberId: bob, amountMinor: 50 }],
    });
    expect(calls[0].searchParams.get('id')).toBe(`eq.${tripId}`);
    expect(calls[1].searchParams.get('trip_id')).toBe(`eq.${tripId}`);
    expect(calls[2].searchParams.get('trip_id')).toBe(`eq.${tripId}`);
  });

  it('supports exact shares and several payers without changing their math', async () => {
    const { service } = setup();
    const result = await service.addExpense({ ...input, currency: 'USD', fxRate: 1,
      paid: [{ memberId: alice, amountMinor: 200 }, { memberId: bob, amountMinor: 100 }],
      shares: [{ memberId: alice, amountMinor: 100 }, { memberId: bob, amountMinor: 200 }],
    });
    expect(result.expense.splits).toEqual([
      { memberId: alice, amountMinor: 100, paidMinor: 200 },
      { memberId: bob, amountMinor: 200, paidMinor: 100 },
    ]);
  });

  it('returns the saved expense on retry and freezes the first exchange rate', async () => {
    const { service, rows } = setup();
    await service.addExpense(input);
    vi.mocked(suggestRate).mockResolvedValue(99);
    const replay = await service.addExpense(input);
    expect(replay.created).toBe(false);
    expect(replay.expense.fx_rate).toBe(1.5);
    expect(rows).toHaveLength(1);
    await expect(service.addExpense({ ...input, title: 'Another dinner' })).rejects.toMatchObject({ status: 409 });
  });

  it('does not duplicate concurrent requests', async () => {
    const { service, rows } = setup();
    const results = await Promise.all([service.addExpense(input), service.addExpense(input)]);
    expect(rows).toHaveLength(1);
    expect(results.map(r => r.created).sort()).toEqual([false, true]);
  });

  it.each([
    { participantIds: [alice, alice] },
    { participantIds: [requestId] },
    { paid: [{ memberId: requestId, amountMinor: 100 }] },
    { paid: [{ memberId: alice, amountMinor: 1.5 }] },
    { currency: 'EUR' },
    { spentAt: '2026-02-30' },
    { tripId: requestId },
    { shares: [{ memberId: alice, amountMinor: 1 }] },
  ])('rejects invalid or cross-trip input: %j', async patch => {
    const { service, rows } = setup();
    await expect(service.addExpense({ ...input, ...patch })).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });
});

describe('REST and MCP transports', () => {
  it('authenticates reads and writes, rejects origins and malformed bodies', async () => {
    const { base, request, rows } = await listen();
    expect((await fetch(base + '/api/trip')).status).toBe(401);
    expect((await request('/api/trip', { headers: { Origin: 'https://other.example' } })).status).toBe(403);
    expect((await request('/api/trip')).status).toBe(200);
    expect((await request('/api/expenses', { method: 'POST', body: '{' })).status).toBe(400);
    expect((await request('/api/expenses', { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await request('/api/expenses', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(65536) }) })).status).toBe(413);
    const added = await request('/api/expenses', { method: 'POST', body: JSON.stringify(input) });
    expect(added.status).toBe(201);
    expect((await added.json()).expense.id).toBe(requestId);
    expect((await request('/api/expenses', { method: 'POST', body: JSON.stringify(input) })).status).toBe(200);
    expect((await request('/api/expenses')).status).toBe(200);
    expect(rows).toHaveLength(1);
  });

  it('reports backend failure without claiming the expense was saved', async () => {
    const { request, fail, rows } = await listen();
    fail();
    const response = await request('/api/expenses', { method: 'POST', body: JSON.stringify(input) });
    expect(response.status).toBe(502);
    expect(rows).toHaveLength(0);
  });

  it('initializes a real MCP client and calls all tools over Streamable HTTP', async () => {
    const { base, rows } = await listen();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['get_trip', 'list_expenses', 'add_expense']);
    expect((await client.callTool({ name: 'get_trip', arguments: {} })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'add_expense', arguments: input })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'list_expenses', arguments: {} })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'add_expense', arguments: { ...input, title: 'Changed' } })).isError).toBe(true);
    expect(rows).toHaveLength(1);
  });
});
