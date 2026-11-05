import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import type { CursorName, PlanRecord, Store, SubRecord } from './types.js';

/** Bump when the schema changes. Stored in the database as `user_version`. */
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  merchant TEXT NOT NULL,
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  period_secs INTEGER NOT NULL,
  active INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_merchant ON plans (merchant);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL,
  subscriber TEXT NOT NULL,
  next_charge_ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  charges INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_plan ON subscriptions (plan_id);
CREATE INDEX IF NOT EXISTS subscriptions_due ON subscriptions (status, next_charge_ts);

CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  tx_hash TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS charges_sub ON charges (sub_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  merchant TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending ON webhook_deliveries (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS sync_state (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

const planRow = z.object({
  id: z.number().int(),
  merchant: z.string(),
  token: z.string(),
  amount: z.string(),
  period_secs: z.number().int(),
  active: z.number().int(),
});

const subRow = z.object({
  id: z.number().int(),
  plan_id: z.number().int(),
  subscriber: z.string(),
  next_charge_ts: z.number().int(),
  status: z.enum(['Active', 'Cancelled']),
  charges: z.number().int(),
});

const valueRow = z.object({ value: z.number().int() });
const idRow = z.object({ id: z.number().int() });

function toPlan(row: unknown): PlanRecord {
  const r = planRow.parse(row);
  return {
    id: r.id,
    merchant: r.merchant,
    token: r.token,
    amount: r.amount,
    periodSecs: r.period_secs,
    active: r.active === 1,
  };
}

function toSub(row: unknown): SubRecord {
  const r = subRow.parse(row);
  return {
    id: r.id,
    planId: r.plan_id,
    subscriber: r.subscriber,
    nextChargeTs: r.next_charge_ts,
    status: r.status,
    charges: r.charges,
  };
}

/** Store backed by a SQLite database using Node's built-in `node:sqlite`. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  /**
   * Open (and create if needed) a database.
   *
   * @param path - File path, or `:memory:` for a throwaway database.
   * @param now - Clock in seconds, injectable for tests. Defaults to the system clock.
   */
  constructor(path: string, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.db = new DatabaseSync(path);
    this.now = now;
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)};`);
  }

  getCursor(name: CursorName): Promise<number> {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE name = ?').get(name);
    return Promise.resolve(row === undefined ? 0 : valueRow.parse(row).value);
  }

  setCursor(name: CursorName, value: number): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO sync_state (name, value) VALUES (?, ?) ' +
          'ON CONFLICT(name) DO UPDATE SET value = excluded.value',
      )
      .run(name, value);
    return Promise.resolve();
  }

  upsertPlan(plan: PlanRecord): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO plans (id, merchant, token, amount, period_secs, active, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ' +
          'merchant = excluded.merchant, token = excluded.token, amount = excluded.amount, ' +
          'period_secs = excluded.period_secs, active = excluded.active, ' +
          'updated_at = excluded.updated_at',
      )
      .run(
        plan.id,
        plan.merchant,
        plan.token,
        plan.amount,
        plan.periodSecs,
        plan.active ? 1 : 0,
        this.now(),
      );
    return Promise.resolve();
  }

  upsertSub(sub: SubRecord): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO subscriptions ' +
          '(id, plan_id, subscriber, next_charge_ts, status, charges, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ' +
          'plan_id = excluded.plan_id, subscriber = excluded.subscriber, ' +
          'next_charge_ts = excluded.next_charge_ts, status = excluded.status, ' +
          'charges = excluded.charges, updated_at = excluded.updated_at',
      )
      .run(
        sub.id,
        sub.planId,
        sub.subscriber,
        sub.nextChargeTs,
        sub.status,
        sub.charges,
        this.now(),
      );
    return Promise.resolve();
  }

  getPlan(id: number): Promise<PlanRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
    return Promise.resolve(row === undefined ? undefined : toPlan(row));
  }

  getSub(id: number): Promise<SubRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    return Promise.resolve(row === undefined ? undefined : toSub(row));
  }

  listActivePlanIds(): Promise<number[]> {
    return Promise.resolve(this.ids('SELECT id FROM plans WHERE active = 1 ORDER BY id'));
  }

  listActiveSubIds(): Promise<number[]> {
    return Promise.resolve(
      this.ids("SELECT id FROM subscriptions WHERE status = 'Active' ORDER BY id"),
    );
  }

  listDueSubs(nowSecs: number, limit: number): Promise<SubRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM subscriptions WHERE status = 'Active' AND next_charge_ts <= ? " +
          'ORDER BY next_charge_ts, id LIMIT ?',
      )
      .all(nowSecs, limit);
    return Promise.resolve(rows.map(toSub));
  }

  close(): void {
    this.db.close();
  }

  private ids(sql: string, ...params: SQLInputValue[]): number[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => idRow.parse(row).id);
  }
}
