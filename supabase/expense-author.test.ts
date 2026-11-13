import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('./migrations/20261113120000_expense_author.sql', import.meta.url), 'utf8');
const trip = '10000000-0000-4000-8000-000000000001';
const payer = '20000000-0000-4000-8000-000000000001';
const author = '20000000-0000-4000-8000-000000000002';
const unknown = '20000000-0000-4000-8000-000000000003';

async function seed(db: PGlite) {
  await db.query('insert into trips (id, name) values ($1, $2)', [trip, 'Local fixture']);
  await db.query('insert into members (id, trip_id, name) values ($1, $3, $4), ($2, $3, $5)',
    [payer, author, trip, 'Payer', 'Author']);
}
async function insert(db: PGlite, createdBy?: string) {
  return db.query(`insert into expenses
    (trip_id, payer_id, title, currency, amount, fx_rate, base_amount, splits${createdBy ? ', created_by_member_id' : ''})
    values ($1, $2, 'Test expense', 'JPY', 100, 1, 100, $3${createdBy ? ', $4' : ''}) returning *`,
  [trip, payer, JSON.stringify([{ memberId: payer, amountMinor: 100 }]), ...(createdBy ? [createdBy] : [])]);
}

describe('expense author SQL migration (isolated PostgreSQL)', () => {
  it('upgrades existing data without attributing old rows and accepts old and new clients', async () => {
    const db = new PGlite();
    try {
      await db.exec('create publication supabase_realtime');
      // Model the previous schema by omitting only the new nullable column.
      const oldSchema = schema.replace(/^.*created_by_member_id uuid.*\n/m, '');
      expect(oldSchema).not.toBe(schema);
      await db.exec(oldSchema);
      await seed(db);
      const old = (await insert(db)).rows[0];
      await db.exec(migration);
      expect((await db.query('select * from expenses')).rows).toEqual([
        { ...old, created_by_member_id: null },
      ]);
      expect((await insert(db)).rows[0]).toMatchObject({ created_by_member_id: null });
      expect((await insert(db, author)).rows[0]).toMatchObject({ payer_id: payer, created_by_member_id: author });
      await expect(insert(db, unknown)).rejects.toMatchObject({ code: '23503' });
      await db.query('delete from members where id = $1', [author]);
      expect((await db.query('select created_by_member_id from expenses')).rows)
        .toEqual(Array.from({ length: 3 }, () => ({ created_by_member_id: null })));
    } finally { await db.close(); }
  }, 30000);

  it('includes the same nullable foreign key in a fresh schema', async () => {
    const db = new PGlite();
    try {
      await db.exec('create publication supabase_realtime');
      await db.exec(schema);
      await seed(db);
      expect((await insert(db, author)).rows[0]).toMatchObject({ created_by_member_id: author });
      expect((await insert(db)).rows[0]).toMatchObject({ created_by_member_id: null });
      await expect(insert(db, unknown)).rejects.toMatchObject({ code: '23503' });
    } finally { await db.close(); }
  }, 30000);
});
