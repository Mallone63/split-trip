import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { allowedPushEndpoint, createPushHandler } from './push';
import { currentDebt, pushMessage, type RawBundle } from './push-content';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = id(1),
  b = id(2),
  c = id(3),
  trip = id(4),
  device = id(5);
const members = [
  { id: a, trip_id: trip, name: 'Пава', unit: 'pair' },
  { id: b, trip_id: trip, name: 'Наташа', unit: 'pair' },
  { id: c, trip_id: trip, name: 'Костя', unit: null },
];
const fixture = (): RawBundle => ({
  trip: { id: trip, base_currency: 'JPY' },
  members,
  expenses: [
    {
      id: id(6),
      trip_id: trip,
      payer_id: a,
      currency: 'JPY',
      title: 'Ужин',
      amount: 600,
      fx_rate: 1,
      base_amount: 600,
      splits: [
        { memberId: a, amountMinor: 200 },
        { memberId: b, amountMinor: 200 },
        { memberId: c, amountMinor: 200 },
      ],
    },
  ],
  payments: [],
  transfers: [],
});
describe('push text and current debts', () => {
  it('formats individual expense share including a zero-share payer', () => {
    const record = fixture().expenses[0];
    const message = pushMessage(
      'expense',
      id(6),
      trip,
      { record, members, recipientId: c, baseCurrency: 'JPY' },
      'https://example.com/split-trip/',
    );
    expect(message.body).toContain('Твоя доля: 200');
    expect(new URL(message.data.url).searchParams.get('expense')).toBe(id(6));
    expect(
      pushMessage(
        'expense',
        id(6),
        trip,
        { record, members, recipientId: id(9), baseCurrency: 'JPY' },
        'https://example.com/split-trip/',
      ).body,
    ).toContain('Твоя доля: 0');
  });
  it('does not claim full repayment for a partial payment, and distinguishes conversion from payment', () => {
    const record = {
      payer_id: c,
      receiver_id: a,
      amount: 100,
      currency: 'JPY',
      paid_currency: 'RUB',
      paid_amount: 6100,
      source_currency: 'JPY',
      source_amount: 100,
      target_currency: 'RUB',
      target_amount: 6100,
    };
    const payment = pushMessage(
      'payment',
      id(7),
      trip,
      { record, members, baseCurrency: 'JPY' },
      'https://example.com/',
    );
    expect(payment.title).toBe('Записано погашение долга');
    expect(payment.body).toContain('Передано:');
    expect(payment.body).toContain('Пава + Наташа');
    expect(
      pushMessage(
        'transfer',
        id(7),
        trip,
        { record, members, baseCurrency: 'JPY' },
        'https://example.com/',
      ).body,
    ).toContain('Оплаты ещё не было');
  });
  it('uses wallet aggregation, partial payments, overpayments and currency transfers exactly as the PWA', () => {
    const bundle = fixture();
    expect(currentDebt(bundle, c, b, 'JPY')?.amountMinor).toBe(200);
    bundle.payments = [
      { payer_id: c, receiver_id: a, amount: 50, currency: 'JPY' },
    ];
    expect(currentDebt(bundle, c, a, 'JPY')?.amountMinor).toBe(150);
    bundle.transfers = [
      {
        payer_id: c,
        receiver_id: a,
        source_currency: 'JPY',
        source_amount: 150,
        target_currency: 'RUB',
        target_amount: 9000,
      },
    ];
    expect(currentDebt(bundle, c, a, 'JPY')).toBeNull();
    expect(currentDebt(bundle, c, a, 'RUB')?.amountMinor).toBe(9000);
    bundle.payments.push({
      payer_id: c,
      receiver_id: a,
      amount: 10000,
      currency: 'RUB',
    });
    expect(currentDebt(bundle, c, a, 'RUB')).toBeNull();
    expect(currentDebt(bundle, a, c, 'RUB')?.amountMinor).toBe(1000);
  });
});
function setup(status = 201) {
  const job = {
    id: id(10),
    trip_id: trip,
    subscription_id: device,
    kind: 'expense',
    source_id: id(6),
    attempts: 1,
    created_at: new Date().toISOString(),
    payload: {
      record: fixture().expenses[0],
      members,
      recipientId: c,
      baseCurrency: 'JPY',
    },
  };
  const sub = {
    id: device,
    trip_id: trip,
    member_id: c,
    endpoint: 'https://web.push.apple.com/Q',
    p256dh: 'key',
    auth: 'auth',
    expenses: true,
    settlements: true,
    reminders: true,
  };
  const changes: {
    table: string;
    method: string;
    body: Record<string, unknown>;
  }[] = [];
  const http = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const table = new URL(String(url)).pathname.split('/').pop()!;
    const method = init?.method ?? 'GET';
    if (method === 'PATCH' || method === 'DELETE')
      changes.push({
        table,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
    if (table === 'claim_push_jobs') return Response.json([job]);
    if (table === 'push_trip_snapshot') return Response.json(fixture());
    if (table === 'push_subscriptions' && method === 'GET')
      return Response.json(sub);
    if (table === 'push_jobs' && method === 'GET')
      return Response.json({ status: 'sending' });
    return Response.json(null);
  });
  const send = vi.fn(async () => {
    if (status !== 201)
      throw Object.assign(new Error('provider detail must not leak'), {
        statusCode: status,
      });
  });
  const db = createClient('https://example.supabase.co', 'service-key', {
    auth: { persistSession: false },
    global: { fetch: http },
  });
  const handler = createPushHandler({
    db,
    publicKey: 'public-key',
    appUrl: 'https://example.com/split-trip/',
    dispatchSecret: 'worker-secret',
    send,
  });
  const dispatch = () =>
    handler(
      new Request('https://api.example.com/push/dispatch', {
        method: 'POST',
        headers: { 'x-push-secret': 'worker-secret' },
      }),
    );
  return { handler, dispatch, job, sub, send, http, changes };
}
describe('push worker and API boundaries', () => {
  it.each([
    'http://web.push.apple.com/x',
    'https://web.push.apple.com.evil.com/x',
    'https://127.0.0.1/x',
    'https://fcm.googleapis.com:444/x',
    'https://a:b@web.push.apple.com/x',
    'https://internal/x',
  ])('rejects SSRF target %s', (value) =>
    expect(allowedPushEndpoint(value)).toBe(false),
  );
  it.each([
    'https://web.push.apple.com/x',
    'https://fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/wpush/x',
  ])('allows browser endpoint %s', (value) =>
    expect(allowedPushEndpoint(value)).toBe(true),
  );
  it('requires a private dispatch secret and enforces the browser origin', async () => {
    const { handler, http } = setup();
    expect(
      (
        await handler(
          new Request('https://api.example.com/push/dispatch', {
            method: 'POST',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          new Request('https://api.example.com/push/config', {
            headers: { Origin: 'https://evil.com' },
          }),
        )
      ).status,
    ).toBe(403);
    expect(http).not.toHaveBeenCalled();
    const config = await handler(
      new Request('https://api.example.com/push/config', {
        headers: { Origin: 'https://example.com' },
      }),
    );
    expect(await config.json()).toEqual({ publicKey: 'public-key' });
  });
  it('marks successful delivery and retains a stable notification tag', async () => {
    const { dispatch, send, changes } = setup();
    expect(await (await dispatch()).json()).toEqual({ processed: 1, sent: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(changes[0].body.status).toBe('sent');
  });
  it.each([404, 410])(
    'removes expired subscriptions on HTTP %s',
    async (status) => {
      const { dispatch, changes } = setup(status);
      await dispatch();
      expect(changes).toContainEqual({
        table: 'push_subscriptions',
        method: 'DELETE',
        body: {},
      });
    },
  );
  it.each([429, 503, 0])(
    'retries transient HTTP %s without storing response bodies',
    async (status) => {
      const { dispatch, changes } = setup(status);
      await dispatch();
      expect(changes[0].body.status).toBe('pending');
      expect(JSON.stringify(changes)).not.toContain('provider detail');
    },
  );
  it('bounds retries and marks permanent failures', async () => {
    const transient = setup(503);
    transient.job.attempts = 8;
    await transient.dispatch();
    expect(transient.changes[0].body.status).toBe('failed');
    const invalid = setup(400);
    await invalid.dispatch();
    expect(invalid.changes[0].body.status).toBe('failed');
  });
  it('does not deliver queued data after changing identity/preferences', async () => {
    const { dispatch, sub, send, changes } = setup();
    sub.member_id = b;
    await dispatch();
    expect(send).not.toHaveBeenCalled();
    expect(changes[0].body.status).toBe('cancelled');
  });
  it('cancels reminders for stale/settled debt before calling the provider', async () => {
    const { dispatch, job, send, changes } = setup();
    job.kind = 'reminder';
    job.payload.record = {
      actor_id: a,
      payer_id: c,
      receiver_id: a,
      currency: 'RUB',
      amount: 300,
    };
    await dispatch();
    expect(send).not.toHaveBeenCalled();
    expect(changes[0].body.status).toBe('cancelled');
  });
  it('authorizes reminders by the selected creditor wallet, without requiring sender pushes', async () => {
    const { handler, http } = setup();
    const request = (actorId: string) => new Request('https://api.example.com/push/remind', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: id(77), tripId: trip, actorId, payerId: c, receiverId: a, currency: 'JPY' }),
    });
    expect((await handler(request(c))).status).toBe(403);
    const response = await handler(request(b));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ queued: false, reason: 'notifications_disabled' });
    expect(http.mock.calls.some(([url]) => String(url).includes('queue_debt_reminder'))).toBe(true);
  });
  it('rejects malformed client input without accessing the database', async () => {
    const { handler, http } = setup();
    const result = await handler(
      new Request('https://api.example.com/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(result.status).toBe(400);
    expect(http).not.toHaveBeenCalled();
  });
});
