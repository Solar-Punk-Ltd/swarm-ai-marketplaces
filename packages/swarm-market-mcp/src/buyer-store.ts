/**
 * Local buyer store: every purchase this wallet made, with the signed PurchaseIntent, and the
 * state of its review.
 *
 * The signed intent exists only at purchase time and cannot be recovered from the chain, so a
 * purchase that is not recorded here can never be reviewed (it is mandatory PoP evidence).
 * `review_state` is a resume hint for submit_review — the chain stays authoritative.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { PurchaseIntentProof } from '@solarpunk/erc8004-adapter';

export type ReviewState = 'none' | 'uploaded' | 'anchored' | 'revoked';

export interface PurchaseRecord {
  txHash: string;
  itemId: string;
  chainId: string;
  payTo: string;
  asset: string; // CAIP-19 as quoted in the 402 challenge
  amount: string;
  purchaseIntent: PurchaseIntentProof | null;
  settledAt: string;
  reviewState: ReviewState;
  agentId: string | null;
  reviewJson: string | null; // exact bytes whose keccak256 is feedbackHash
  feedbackUri: string | null;
  feedbackHash: string | null;
  feedbackIndex: string | null;
  feedbackTx: string | null;
}

interface Row {
  tx_hash: string;
  item_id: string;
  chain_id: string;
  pay_to: string;
  asset: string;
  amount: string;
  purchase_intent: string | null;
  settled_at: string;
  review_state: ReviewState;
  agent_id: string | null;
  review_json: string | null;
  feedback_uri: string | null;
  feedback_hash: string | null;
  feedback_index: string | null;
  feedback_tx: string | null;
}

export class BuyerStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS purchases (
        tx_hash         TEXT PRIMARY KEY,
        item_id         TEXT NOT NULL,
        chain_id        TEXT NOT NULL,
        pay_to          TEXT NOT NULL,
        asset           TEXT NOT NULL,
        amount          TEXT NOT NULL,
        purchase_intent TEXT,
        settled_at      TEXT NOT NULL,
        review_state    TEXT NOT NULL DEFAULT 'none',
        agent_id        TEXT,
        review_json     TEXT,
        feedback_uri    TEXT,
        feedback_hash   TEXT,
        feedback_index  TEXT,
        feedback_tx     TEXT
      );
    `);
  }

  recordPurchase(p: {
    txHash: string;
    itemId: string;
    chainId: string;
    payTo: string;
    asset: string;
    amount: string;
    purchaseIntent: PurchaseIntentProof;
    settledAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO purchases
           (tx_hash, item_id, chain_id, pay_to, asset, amount, purchase_intent, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.txHash.toLowerCase(),
        p.itemId,
        p.chainId,
        p.payTo,
        p.asset,
        p.amount,
        JSON.stringify(p.purchaseIntent),
        p.settledAt,
      );
  }

  getPurchase(txHash: string): PurchaseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM purchases WHERE tx_hash = ?')
      .get(txHash.toLowerCase()) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  listPurchases(unreviewedOnly = false): PurchaseRecord[] {
    const rows = this.db
      .prepare(
        unreviewedOnly
          ? "SELECT * FROM purchases WHERE review_state IN ('none', 'uploaded', 'revoked') ORDER BY settled_at DESC"
          : 'SELECT * FROM purchases ORDER BY settled_at DESC',
      )
      .all() as Row[];
    return rows.map(toRecord);
  }

  /** The review is on Swarm but not yet anchored: a re-run resumes at giveFeedback. */
  markUploaded(
    txHash: string,
    r: { agentId: string; reviewJson: string; feedbackUri: string; feedbackHash: string },
  ): void {
    this.db
      .prepare(
        `UPDATE purchases SET review_state = 'uploaded', agent_id = ?, review_json = ?,
           feedback_uri = ?, feedback_hash = ?, feedback_index = NULL, feedback_tx = NULL
         WHERE tx_hash = ?`,
      )
      .run(r.agentId, r.reviewJson, r.feedbackUri, r.feedbackHash, txHash.toLowerCase());
  }

  markAnchored(
    txHash: string,
    r: {
      agentId: string;
      feedbackIndex: string;
      feedbackTx?: string;
      feedbackUri?: string;
      feedbackHash?: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE purchases SET review_state = 'anchored', agent_id = ?, feedback_index = ?,
           feedback_tx = COALESCE(?, feedback_tx), feedback_uri = COALESCE(?, feedback_uri),
           feedback_hash = COALESCE(?, feedback_hash)
         WHERE tx_hash = ?`,
      )
      .run(
        r.agentId,
        r.feedbackIndex,
        r.feedbackTx ?? null,
        r.feedbackUri ?? null,
        r.feedbackHash ?? null,
        txHash.toLowerCase(),
      );
  }

  markRevoked(txHash: string): void {
    this.db
      .prepare("UPDATE purchases SET review_state = 'revoked' WHERE tx_hash = ?")
      .run(txHash.toLowerCase());
  }

  /** The chain shows no live review for this purchase: forget a stale local claim. */
  resetReview(txHash: string): void {
    this.db
      .prepare(
        `UPDATE purchases SET review_state = 'none', review_json = NULL, feedback_uri = NULL,
           feedback_hash = NULL, feedback_index = NULL, feedback_tx = NULL
         WHERE tx_hash = ?`,
      )
      .run(txHash.toLowerCase());
  }

  findByFeedback(agentId: string, feedbackIndex: string): PurchaseRecord | null {
    const row = this.db
      .prepare('SELECT * FROM purchases WHERE agent_id = ? AND feedback_index = ?')
      .get(agentId, feedbackIndex) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  close(): void {
    this.db.close();
  }
}

function toRecord(row: Row): PurchaseRecord {
  return {
    txHash: row.tx_hash,
    itemId: row.item_id,
    chainId: row.chain_id,
    payTo: row.pay_to,
    asset: row.asset,
    amount: row.amount,
    purchaseIntent: row.purchase_intent
      ? (JSON.parse(row.purchase_intent) as PurchaseIntentProof)
      : null,
    settledAt: row.settled_at,
    reviewState: row.review_state,
    agentId: row.agent_id,
    reviewJson: row.review_json,
    feedbackUri: row.feedback_uri,
    feedbackHash: row.feedback_hash,
    feedbackIndex: row.feedback_index,
    feedbackTx: row.feedback_tx,
  };
}

let shared: BuyerStore | null = null;

/** Process-wide store, opened on first use (tools that never touch reviews don't create the file). */
export function getBuyerStore(dbPath: string): BuyerStore {
  shared ??= new BuyerStore(dbPath);
  return shared;
}
