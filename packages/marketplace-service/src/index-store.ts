import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  FeedbackRevokedEvent,
  NewFeedbackEvent,
  ResponseAppendedEvent,
} from '@solarpunk/erc8004-adapter';

/**
 * pending  — anchored, not yet checked (or a transient fetch failure to retry)
 * valid    — verifyReview + verifyPoP passed
 * invalid  — failed a rule (reason says which); never counts
 */
export type ReviewStatus = 'pending' | 'valid' | 'invalid';

export interface IndexedReview {
  agentId: string;
  clientAddress: string;
  feedbackIndex: string;
  blockNumber: number;
  logIndex: number;
  transactionHash: string;
  value: string;
  valueDecimals: number;
  feedbackURI: string;
  feedbackHash: string;
  revoked: boolean;
  status: ReviewStatus;
  reason: string | null;
  attempts: number;
  purchaseTx: string | null;
  itemId: string | null;
  blockTime: number | null;
}

interface Row {
  agent_id: string;
  client_address: string;
  feedback_index: string;
  block_number: number;
  log_index: number;
  tx_hash: string;
  value: string;
  value_decimals: number;
  feedback_uri: string;
  feedback_hash: string;
  revoked: number;
  status: ReviewStatus;
  reason: string | null;
  attempts: number;
  purchase_tx: string | null;
  item_id: string | null;
  block_time: number | null;
}

/**
 * The indexer's cache of the on-chain feedback census plus each review's verdict. It is never the
 * source of truth: every row is reproducible from chain events and Swarm content.
 */
export class IndexStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexer_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        agent_id       TEXT NOT NULL,
        client_address TEXT NOT NULL,
        feedback_index TEXT NOT NULL,
        block_number   INTEGER NOT NULL,
        log_index      INTEGER NOT NULL,
        tx_hash        TEXT NOT NULL,
        value          TEXT NOT NULL,
        value_decimals INTEGER NOT NULL,
        feedback_uri   TEXT NOT NULL,
        feedback_hash  TEXT NOT NULL,
        revoked        INTEGER NOT NULL DEFAULT 0,
        status         TEXT NOT NULL DEFAULT 'pending',
        reason         TEXT,
        attempts       INTEGER NOT NULL DEFAULT 0,
        purchase_tx    TEXT,
        item_id        TEXT,
        block_time     INTEGER,
        PRIMARY KEY (agent_id, client_address, feedback_index)
      );
      CREATE INDEX IF NOT EXISTS reviews_status ON reviews(status);
      CREATE TABLE IF NOT EXISTS responses (
        agent_id       TEXT NOT NULL,
        client_address TEXT NOT NULL,
        feedback_index TEXT NOT NULL,
        responder      TEXT NOT NULL,
        response_uri   TEXT NOT NULL,
        response_hash  TEXT NOT NULL,
        block_number   INTEGER NOT NULL,
        log_index      INTEGER NOT NULL,
        PRIMARY KEY (block_number, log_index)
      );
      CREATE TABLE IF NOT EXISTS last_events (
        agent_id     TEXT PRIMARY KEY,
        block_number INTEGER NOT NULL,
        log_index    INTEGER NOT NULL,
        tx_hash      TEXT NOT NULL
      );
    `);
  }

  /** Last block fully ingested, or null before the first tick. */
  getCheckpoint(): number | null {
    const row = this.db
      .prepare("SELECT value FROM indexer_state WHERE key = 'checkpoint'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : null;
  }

  /**
   * Stores one block range of events and advances the checkpoint atomically, so a crash never
   * leaves a half-ingested range behind the checkpoint.
   */
  ingest(
    toBlock: number,
    events: {
      feedback: NewFeedbackEvent[];
      revocations: FeedbackRevokedEvent[];
      responses: ResponseAppendedEvent[];
    },
  ): void {
    const insertReview = this.db.prepare(
      `INSERT OR IGNORE INTO reviews
         (agent_id, client_address, feedback_index, block_number, log_index, tx_hash,
          value, value_decimals, feedback_uri, feedback_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const revoke = this.db.prepare(
      'UPDATE reviews SET revoked = 1 WHERE agent_id = ? AND client_address = ? AND feedback_index = ?',
    );
    const insertResponse = this.db.prepare(
      `INSERT OR IGNORE INTO responses
         (agent_id, client_address, feedback_index, responder, response_uri, response_hash,
          block_number, log_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const lastEvent = this.db.prepare(
      `INSERT INTO last_events (agent_id, block_number, log_index, tx_hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET block_number = excluded.block_number,
         log_index = excluded.log_index, tx_hash = excluded.tx_hash
       WHERE excluded.block_number > last_events.block_number
          OR (excluded.block_number = last_events.block_number AND excluded.log_index > last_events.log_index)`,
    );

    this.db.transaction(() => {
      // Feedback first: a revocation in the same range must find its row.
      for (const e of events.feedback) {
        insertReview.run(
          e.agentId.toString(),
          e.clientAddress.toLowerCase(),
          e.feedbackIndex.toString(),
          e.blockNumber,
          e.logIndex,
          e.transactionHash,
          e.value.toString(),
          e.valueDecimals,
          e.feedbackURI,
          e.feedbackHash,
        );
      }
      for (const r of events.revocations) {
        revoke.run(r.agentId.toString(), r.clientAddress.toLowerCase(), r.feedbackIndex.toString());
      }
      for (const r of events.responses) {
        insertResponse.run(
          r.agentId.toString(),
          r.clientAddress.toLowerCase(),
          r.feedbackIndex.toString(),
          r.responder,
          r.responseURI,
          r.responseHash,
          r.blockNumber,
          r.logIndex,
        );
      }
      // Feedback and revocations are what a buyer's census checks after the checkpoint.
      for (const e of [...events.feedback, ...events.revocations]) {
        lastEvent.run(e.agentId.toString(), e.blockNumber, e.logIndex, e.transactionHash);
      }
      this.db
        .prepare(
          `INSERT INTO indexer_state (key, value) VALUES ('checkpoint', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(toBlock));
    })();
  }

  /** Oldest unverified, non-revoked reviews first (chain order matters for one-per-purchase). */
  pending(limit: number): IndexedReview[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reviews WHERE status = 'pending' AND revoked = 0
         ORDER BY block_number, log_index LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map(toReview);
  }

  markVerified(
    key: { agentId: string; clientAddress: string; feedbackIndex: string },
    verdict:
      | { status: 'valid'; purchaseTx: string; itemId: string; blockTime: number }
      | { status: 'invalid'; reason: string }
      | { status: 'pending'; reason: string }, // transient: retry later
  ): void {
    const purchaseTx = verdict.status === 'valid' ? verdict.purchaseTx.toLowerCase() : null;
    const itemId = verdict.status === 'valid' ? verdict.itemId : null;
    const blockTime = verdict.status === 'valid' ? verdict.blockTime : null;
    const reason = verdict.status === 'valid' ? null : verdict.reason;
    this.db
      .prepare(
        `UPDATE reviews SET status = ?, reason = ?, purchase_tx = ?, item_id = ?,
           block_time = COALESCE(?, block_time), attempts = attempts + 1
         WHERE agent_id = ? AND client_address = ? AND feedback_index = ?`,
      )
      .run(
        verdict.status,
        reason,
        purchaseTx,
        itemId,
        blockTime,
        key.agentId,
        key.clientAddress.toLowerCase(),
        key.feedbackIndex,
      );
  }

  /** Every anchored entry for a seller (revoked included — callers filter). */
  reviewsFor(agentId: string): IndexedReview[] {
    const rows = this.db
      .prepare('SELECT * FROM reviews WHERE agent_id = ? ORDER BY block_number, log_index')
      .all(agentId) as Row[];
    return rows.map(toReview);
  }

  responseCount(agentId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM responses WHERE agent_id = ?')
      .get(agentId) as { n: number };
    return row.n;
  }

  lastEvent(agentId: string): { block: number; txHash: string } | null {
    const row = this.db
      .prepare('SELECT block_number, tx_hash FROM last_events WHERE agent_id = ?')
      .get(agentId) as { block_number: number; tx_hash: string } | undefined;
    return row ? { block: row.block_number, txHash: row.tx_hash } : null;
  }

  close(): void {
    this.db.close();
  }
}

function toReview(row: Row): IndexedReview {
  return {
    agentId: row.agent_id,
    clientAddress: row.client_address,
    feedbackIndex: row.feedback_index,
    blockNumber: row.block_number,
    logIndex: row.log_index,
    transactionHash: row.tx_hash,
    value: row.value,
    valueDecimals: row.value_decimals,
    feedbackURI: row.feedback_uri,
    feedbackHash: row.feedback_hash,
    revoked: row.revoked === 1,
    status: row.status,
    reason: row.reason,
    attempts: row.attempts,
    purchaseTx: row.purchase_tx,
    itemId: row.item_id,
    blockTime: row.block_time,
  };
}
