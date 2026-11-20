import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type BatchStatus = 'pending' | 'usable' | 'failed';

export interface BatchRow {
  agentId: string;
  batchId: string | null; // null while the purchase transaction is in flight
  status: BatchStatus;
  error: string | null;
  updatedAt: string;
}

export type ReserveResult =
  | { ok: true; issued: number }
  | { ok: false; reason: 'quota_exceeded' | 'other_client'; issued: number };

// Local store for the review-storage subsidy: one postage batch per seller, and per purchase how
// many envelopes have been issued (the per-purchase cap) plus a log of what was stamped.
export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seller_batches (
        agent_id   TEXT PRIMARY KEY,
        batch_id   TEXT,
        status     TEXT NOT NULL,
        error      TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS purchase_requests (
        tx_hash          TEXT PRIMARY KEY,
        client_address   TEXT NOT NULL,
        agent_id         TEXT NOT NULL,
        envelopes_issued INTEGER NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS envelopes (
        tx_hash   TEXT NOT NULL,
        address   TEXT NOT NULL,
        batch_id  TEXT NOT NULL,
        issued_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS envelopes_tx_hash ON envelopes(tx_hash);
    `);
  }

  getBatch(agentId: string): BatchRow | null {
    const row = this.db
      .prepare(
        'SELECT agent_id, batch_id, status, error, updated_at FROM seller_batches WHERE agent_id = ?',
      )
      .get(agentId) as
      | {
          agent_id: string;
          batch_id: string | null;
          status: BatchStatus;
          error: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      agentId: row.agent_id,
      batchId: row.batch_id,
      status: row.status,
      error: row.error,
      updatedAt: row.updated_at,
    };
  }

  setBatch(
    agentId: string,
    status: BatchStatus,
    batchId: string | null,
    error: string | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO seller_batches (agent_id, batch_id, status, error, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           batch_id = excluded.batch_id, status = excluded.status,
           error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(agentId, batchId, status, error, new Date().toISOString());
  }

  /**
   * Atomically counts `count` more envelopes against a purchase. Refuses beyond `max`, and refuses
   * a second requester for the same purchase (belt-and-braces: PoP already pins the payer).
   */
  reserveEnvelopes(
    txHash: string,
    clientAddress: string,
    agentId: string,
    count: number,
    max: number,
  ): ReserveResult {
    const key = txHash.toLowerCase();
    const client = clientAddress.toLowerCase();
    return this.db.transaction((): ReserveResult => {
      const row = this.db
        .prepare('SELECT client_address, envelopes_issued FROM purchase_requests WHERE tx_hash = ?')
        .get(key) as { client_address: string; envelopes_issued: number } | undefined;
      const issued = row?.envelopes_issued ?? 0;
      if (row && row.client_address !== client) {
        return { ok: false, reason: 'other_client', issued };
      }
      if (issued + count > max) return { ok: false, reason: 'quota_exceeded', issued };
      this.db
        .prepare(
          `INSERT INTO purchase_requests (tx_hash, client_address, agent_id, envelopes_issued, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(tx_hash) DO UPDATE SET
             envelopes_issued = excluded.envelopes_issued, updated_at = excluded.updated_at`,
        )
        .run(key, client, agentId, issued + count, new Date().toISOString());
      return { ok: true, issued: issued + count };
    })();
  }

  /** Gives back a reservation whose envelopes could not be created. */
  releaseEnvelopes(txHash: string, count: number): void {
    this.db
      .prepare(
        `UPDATE purchase_requests SET envelopes_issued = MAX(envelopes_issued - ?, 0), updated_at = ?
         WHERE tx_hash = ?`,
      )
      .run(count, new Date().toISOString(), txHash.toLowerCase());
  }

  recordEnvelopes(txHash: string, batchId: string, addresses: string[]): void {
    const insert = this.db.prepare(
      'INSERT INTO envelopes (tx_hash, address, batch_id, issued_at) VALUES (?, ?, ?, ?)',
    );
    const issuedAt = new Date().toISOString();
    this.db.transaction(() => {
      for (const address of addresses) insert.run(txHash.toLowerCase(), address, batchId, issuedAt);
    })();
  }

  close(): void {
    this.db.close();
  }
}
