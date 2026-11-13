import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { suggestRate } from '../src/lib/fx';
import { aggregateByUnit, computeBalances } from '../src/lib/balances';
import { isWalletOnlyExpense } from '../src/lib/expenseView';
import type { Expense } from '../src/lib/types';
import { createService } from './service';
import { createHttpServer } from './http';

vi.mock('../src/lib/fx', async (original) => ({
  ...await original<typeof import('../src/lib/fx')>(), suggestRate: vi.fn(async () => 1.5),
}));

const tripId = '10000000-0000-4000-8000-000000000000';
const alice = '20000000-0000-4000-8000-000000000000';
const bob = '30000000-0000-4000-8000-000000000000';
const charlie = '50000000-0000-4000-8000-000000000000';
const requestId = '40000000-0000-4000-8000-000000000000';
const token = 'a'.repeat(64);
const input = {
  requestId, title: 'Ужин', currency: 'JPY', spentAt: '2026-11-09',
  participantIds: [bob, alice], paid: [{ memberId: alice, amountMinor: 101 }],
};
const personalInput = {
  requestId, kind: 'personal', title: '7-Eleven', currency: 'JPY', spentAt: '2026-11-13',
  memberId: bob, amountMinor: 4501,
};

// Exercise the actual Supabase HTTP client against an in-memory PostgREST boundary.
function setup(paired = false, beforeRead?: (table: string) => Promise<void>) {
  const rows: Record<string, unknown>[] = [];
  const calls: URL[] = [];
  const members = [
    { id: alice, trip_id: tripId, name: 'Alice', unit: paired ? 'couple' : null },
    { id: bob, trip_id: tripId, name: 'Bob', unit: paired ? 'couple' : null },
    { id: charlie, trip_id: tripId, name: 'Charlie', unit: null },
  ];
  let failInsert = false;
  const db = createClient('https://example.supabase.co', 'anon-key', {
    auth: { persistSession: false },
    global: { fetch: async (url, init) => {
      const parsed = new URL(String(url));
      calls.push(parsed);
      const table = parsed.pathname.split('/').pop();
      if (init?.method !== 'POST') await beforeRead?.(table ?? '');
      let body: unknown;
      let status = 200;
      if (table === 'trips') body = { id: tripId, name: 'Japan', base_currency: 'USD' };
      else if (table === 'members') body = members;
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
  return { service: createService(db, tripId), rows, calls, members, fail: () => { failInsert = true; } };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()));
  vi.mocked(suggestRate).mockResolvedValue(1.5);
});

async function listen(paired = false) {
  const fixture = setup(paired);
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
  it('starts the duplicate lookup while membership is loading and waits before writing', async () => {
    let releaseMembers!: () => void;
    const membersReady = new Promise<void>(resolve => { releaseMembers = resolve; });
    const { service, rows, calls } = setup(true, async table => {
      if (table === 'members') await membersReady;
    });
    const pending = service.addExpense(personalInput);
    try {
      await vi.waitFor(() => {
        expect(calls.some(url => url.pathname.endsWith('/expenses') &&
          url.searchParams.get('id') === `eq.${requestId}`)).toBe(true);
      });
      expect(rows).toHaveLength(0);
    } finally {
      releaseMembers();
      await pending;
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 4501, payer_id: bob });
  });

  it('accepts an explicit shared kind and preserves legacy requests', async () => {
    const { service, rows } = setup();
    const original = await service.addExpense(input);
    const replay = await service.addExpense({ ...input, kind: 'shared' });
    expect(replay).toEqual({ ...original, created: false });
    expect(rows).toHaveLength(1);
  });

  it('adds a personal expense for the whole wallet with no wallet debt', async () => {
    vi.mocked(suggestRate).mockResolvedValue(0.0001);
    const { service, members } = setup(true);
    const { expense: row } = await service.addExpense(personalInput);
    expect(row).toMatchObject({
      payer_id: bob, amount: 4501, base_amount: 46, fx_rate: 0.0001,
      splits: [
        { memberId: alice, amountMinor: 2250 },
        { memberId: bob, amountMinor: 2251, paidMinor: 4501 },
      ],
    });
    const expense: Expense = {
      id: row.id, tripId: row.trip_id, payerId: row.payer_id, title: row.title,
      currency: 'JPY', amountMinor: row.amount, fxRate: row.fx_rate,
      baseAmountMinor: row.base_amount, splits: row.splits, spentAt: row.spent_at,
    };
    const appMembers = members.map(m => ({ ...m, tripId: m.trip_id }));
    const balances = computeBalances(appMembers, [expense], 'JPY');
    expect(aggregateByUnit(appMembers, balances).map(w => w.netMinor)).toEqual([0, 0]);
    expect(isWalletOnlyExpense(expense, new Set([alice, bob]))).toBe(true);
    expect(isWalletOnlyExpense(expense, new Set([charlie]))).toBe(false);
  });

  it('keeps an unpaired personal expense solo instead of grouping all null units', async () => {
    const { service } = setup();
    const { expense } = await service.addExpense(personalInput);
    expect(expense.splits).toEqual([{ memberId: bob, amountMinor: 4501, paidMinor: 4501 }]);
  });

  it('supports a one-yen personal expense with a zero share for the partner', async () => {
    const { service } = setup(true);
    const { expense } = await service.addExpense({ ...personalInput, amountMinor: 1 });
    expect(expense.splits).toEqual([
      { memberId: alice, amountMinor: 0 }, { memberId: bob, amountMinor: 1, paidMinor: 1 },
    ]);
  });

  it.each(['RUB', 'USD', 'JPY'])('accepts personal integer minor amounts in %s', async currency => {
    const { service } = setup(true);
    const { expense } = await service.addExpense({ ...personalInput, currency, amountMinor: 101, fxRate: 1 });
    expect(expense.amount).toBe(101);
    expect(expense.currency).toBe(currency);
    expect(expense.base_amount).toBe(currency === 'JPY' ? 10100 : 101);
  });

  it('replays personal expenses without duplicates and retains the frozen rate', async () => {
    const { service, rows } = setup(true);
    const results = await Promise.all([
      service.addExpense(personalInput), service.addExpense(personalInput),
    ]);
    expect(results.map(r => r.created).sort()).toEqual([false, true]);
    vi.mocked(suggestRate).mockResolvedValue(99);
    expect(await service.addExpense(personalInput)).toMatchObject({ created: false, expense: { fx_rate: 1.5 } });
    await expect(service.addExpense({ ...personalInput, amountMinor: 4502 })).rejects.toMatchObject({ status: 409 });
    expect(rows).toHaveLength(1);
  });

  it('rejects a retry after wallet membership changes instead of rewriting the saved split', async () => {
    const { service, rows, members } = setup(true);
    const saved = await service.addExpense(personalInput);
    members[0].unit = null;
    await expect(service.addExpense(personalInput)).rejects.toMatchObject({ status: 409 });
    expect(rows).toEqual([saved.expense]);
  });

  it.each([
    { memberId: undefined }, { memberId: requestId }, { amountMinor: undefined },
    { amountMinor: 0 }, { amountMinor: -1 }, { amountMinor: 1.5 },
    { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'other' }, { participantIds: [bob] },
    { paid: [{ memberId: bob, amountMinor: 4501 }] },
    { shares: [{ memberId: bob, amountMinor: 4501 }] },
  ])('rejects incomplete or mixed personal payloads: %j', async patch => {
    const { service, rows } = setup(true);
    await expect(service.addExpense({ ...personalInput, ...patch })).rejects.toThrow();
    expect(rows).toHaveLength(0);
  });

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
    { participantIds: undefined },
    { paid: undefined },
    { memberId: alice },
    { amountMinor: 101 },
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
  it('creates and replays personal expenses through REST and rejects mixed modes', async () => {
    const { request, rows } = await listen(true);
    const post = (body: unknown) => request('/api/expenses', { method: 'POST', body: JSON.stringify(body) });
    const response = await post(personalInput);
    expect(response.status).toBe(201);
    expect((await response.json()).expense.splits).toHaveLength(2);
    expect((await post(personalInput)).status).toBe(200);
    expect((await post({ ...personalInput, paid: input.paid })).status).toBe(400);
    expect((await post({ ...personalInput, memberId: requestId })).status).toBe(400);
    expect(rows).toHaveLength(1);
  });

  it('advertises both kinds in MCP and records a personal expense through the real client', async () => {
    const { base, rows } = await listen(true);
    const client = new Client({ name: 'personal-test-client', version: '1.0.0' });
    cleanup.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const tool = (await client.listTools()).tools.find(t => t.name === 'add_expense')!;
    expect(tool.inputSchema.properties).toMatchObject({
      kind: { enum: ['shared', 'personal'], default: 'shared' },
      memberId: { type: 'string' }, amountMinor: { type: 'integer' },
    });
    expect(tool.inputSchema.required).not.toContain('participantIds');
    expect(tool.inputSchema.required).not.toContain('paid');
    const result = await client.callTool({ name: 'add_expense', arguments: personalInput });
    expect(result.isError).not.toBe(true);
    expect(rows[0]).toMatchObject({ amount: 4501, payer_id: bob });
    expect((await client.callTool({ name: 'add_expense', arguments: personalInput })).isError).not.toBe(true);
    expect((await client.callTool({ name: 'add_expense', arguments: { ...personalInput, memberId: requestId } })).isError).toBe(true);
    expect((await client.callTool({ name: 'add_expense', arguments: { ...personalInput, paid: input.paid } })).isError).toBe(true);
    expect(rows).toHaveLength(1);
  });

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
