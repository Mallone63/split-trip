import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = readFileSync(
  new URL('./migrations/20261115070000_web_push.sql', import.meta.url),
  'utf8',
);
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const trip = id(1),
  otherTrip = id(2),
  a = id(11),
  b = id(12),
  c = id(13),
  d = id(14),
  outside = id(15);
let db: PGlite;
const jobs = () =>
  db.query<{
    kind: string;
    member_id: string;
    status: string;
    payload: unknown;
  }>(
    `select j.kind,s.member_id,j.status,j.payload from push_jobs j join push_subscriptions s on s.id=j.subscription_id order by s.member_id`,
  );
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    'create publication supabase_realtime;create role anon;create role authenticated;create role service_role bypassrls;grant usage on schema public to anon,authenticated,service_role;',
  );
  await db.exec(schema.split('-- Web Push infrastructure')[0]);
  await db.query(
    "insert into trips(id,name) values ($1,'Fixture'),($2,'Other')",
    [trip, otherTrip],
  );
  for (const [m, unit, t] of [
    [a, 'pair', trip],
    [b, 'pair', trip],
    [c, null, trip],
    [d, null, trip],
    [outside, null, otherTrip],
  ])
    await db.query(
      'insert into members(id,trip_id,name,unit) values($1::uuid,$2,$1::text,$3)',
      [m, t, unit],
    );
  // Pre-existing expense must never be broadcast by migration.
  await db.query(
    "insert into expenses(trip_id,payer_id,title,currency,amount,fx_rate,base_amount,splits) values($1,$2,'Old','JPY',100,1,100,$3)",
    [trip, a, JSON.stringify([{ memberId: c, amountMinor: 100 }])],
  );
  await db.exec(migration);
  for (const [n, m] of [
    [21, a],
    [22, b],
    [23, c],
    [24, d],
    [25, outside],
  ] as const)
    await db.query('select save_push_subscription($1,$2,$3,$4,$5,$6,$7,$8)', [
      id(n),
      'hash',
      m === outside ? otherTrip : trip,
      m,
      `https://fcm.googleapis.com/${n}`,
      'key',
      'auth',
      JSON.stringify({ expenses: true, settlements: true, reminders: true }),
    ]);
}, 30000);
afterAll(async () => {
  await db.close();
});
async function clear() {
  await db.exec('delete from push_jobs;delete from push_reminders;');
}
async function expense(silent = false) {
  return db.query<{ id: string }>(
    `insert into expenses(trip_id,payer_id,created_by_member_id,title,currency,amount,fx_rate,base_amount,splits,silent)
values($1,$2,$2,'New','JPY',100,1,100,$3,$4) returning id`,
    [
      trip,
      a,
      JSON.stringify([
        { memberId: a, amountMinor: 50, paidMinor: 80 },
        { memberId: b, amountMinor: 50, paidMinor: 0 },
        { memberId: c, amountMinor: 0, paidMinor: 20 },
        { memberId: d, amountMinor: 0, paidMinor: 0 },
        { memberId: outside, amountMinor: 1 },
      ]),
      silent,
    ],
  );
}
describe('Web Push SQL upgrade', () => {
  it('does not broadcast history; excludes author, irrelevant placeholders and other trips, includes secondary payer', async () => {
    expect((await jobs()).rows).toHaveLength(0);
    await expense();
    expect((await jobs()).rows.map((r) => r.member_id)).toEqual([b, c]);
    await clear();
  });
  it('never queues silent expenses, including deletion', async () => {
    const e = await expense(true);
    expect((await jobs()).rows).toHaveLength(0);
    await db.query('delete from expenses where id=$1', [e.rows[0].id]);
    expect((await jobs()).rows).toHaveLength(0);
  });
  it('queues payments and transfers to both wallets, excluding known author; undo cancels pending originals', async () => {
    const p = await db.query<{ id: string }>(
      "insert into payments(trip_id,payer_id,receiver_id,amount,currency,created_by_member_id) values($1,$2,$3,50,'JPY',$2) returning id",
      [trip, c, a],
    );
    expect((await jobs()).rows.map((r) => r.member_id)).toEqual([a, b]);
    await db.query('delete from payments where id=$1', [p.rows[0].id]);
    expect(
      (await jobs()).rows
        .filter((r) => r.kind === 'payment')
        .every((r) => r.status === 'cancelled'),
    ).toBe(true);
    expect(
      (await jobs()).rows
        .filter((r) => r.kind === 'payment_undo')
        .map((r) => r.member_id),
    ).toEqual([a, b, c]);
    await clear();
    await db.query(
      "insert into debt_transfers(trip_id,payer_id,receiver_id,source_currency,source_amount,target_currency,target_amount,created_by_member_id) values($1,$2,$3,'JPY',100,'RUB',60,$3)",
      [trip, c, a],
    );
    expect((await jobs()).rows.map((r) => r.member_id)).toEqual([b, c]);
    await clear();
  });
  it('retains jobs on normal subscription refresh; cancels them on changing identity', async () => {
    await expense();
    const save = (member: string) =>
      db.query('select save_push_subscription($1,$2,$3,$4,$5,$6,$7,$8)', [
        id(22),
        'hash',
        trip,
        member,
        'https://fcm.googleapis.com/22',
        'key',
        'auth',
        JSON.stringify({ expenses: true, settlements: true, reminders: true }),
      ]);
    await save(b);
    expect((await jobs()).rows).toHaveLength(2);
    await save(d);
    expect((await jobs()).rows.map((r) => r.member_id)).toEqual([c]);
    await save(b);
    await clear();
  });
  it('enforces device ownership and denies anon access to subscriptions and worker RPCs', async () => {
    await expect(
      db.query('select save_push_subscription($1,$2,$3,$4,$5,$6,$7,$8)', [
        id(22),
        'wrong',
        trip,
        b,
        'https://fcm.googleapis.com/22',
        'key',
        'auth',
        JSON.stringify({ expenses: true, settlements: true, reminders: true }),
      ]),
    ).rejects.toThrow('INVALID_DEVICE');
    await db.exec('set role anon');
    await expect(db.query('select * from push_subscriptions')).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.query('select * from claim_push_jobs(30)')).rejects.toThrow(
      /permission denied/,
    );
    await db.exec('reset role');
  });
  it('claims once while leased, retries after lease expiry, and applies a wallet cooldown', async () => {
    await expense();
    expect(
      (await db.query('select * from claim_push_jobs(30)')).rows,
    ).toHaveLength(2);
    expect(
      (await db.query('select * from claim_push_jobs(30)')).rows,
    ).toHaveLength(0);
    await db.exec(
      "update push_jobs set available_at=now()-interval '1 second'",
    );
    expect(
      (
        await db.query<{ attempts: number }>(
          'select * from claim_push_jobs(30)',
        )
      ).rows.every((r) => r.attempts === 2),
    ).toBe(true);
    await clear();
    const reminder = (rid: string, actor = a) =>
      db.query('select queue_debt_reminder($1,$2,$3,$4,$5,$6,$7)', [
        trip,
        'pair',
        `solo:${c}`,
        actor,
        [c],
        rid,
        JSON.stringify({ record: { actor_id: actor } }),
      ]);
    await reminder(id(40));
    await reminder(id(40)); // uncertain retry is safe
    expect((await jobs()).rows).toHaveLength(1);
    await expect(reminder(id(41), b)).rejects.toThrow('REMINDER_COOLDOWN');
    await clear();
  });
  it('does not consume a cooldown for recipients with reminders off', async () => {
    await db.exec(
      `update push_subscriptions set reminders=false where member_id='${c}'`,
    );
    const result = await db.query<{ queue_debt_reminder: boolean }>(
      'select queue_debt_reminder($1,$2,$3,$4,$5,$6,$7)',
      [trip, 'pair', `solo:${c}`, a, [c], id(42), '{}'],
    );
    expect(result.rows[0].queue_debt_reminder).toBe(false);
    expect((await db.query('select * from push_reminders')).rows).toHaveLength(
      0,
    );
  });
  it('installs the same complete schema on a fresh database', async () => {
    const fresh = new PGlite();
    try {
      await fresh.exec(
        'create publication supabase_realtime;create role anon;create role authenticated;create role service_role bypassrls;',
      );
      await fresh.exec(schema);
      expect((await fresh.query('select * from push_jobs')).rows).toEqual([]);
    } finally {
      await fresh.close();
    }
  }, 30000);
});
