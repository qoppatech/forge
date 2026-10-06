import type { Chain, SignatureInfo } from "../chain";
import type { Db } from "../db";
import type { Reconciler } from "./reconciler";

const PAGE = 500;

/**
 * Polling indexer with a persisted cursor per watched address (vault PDA and vault token
 * account). It ingests finalized transactions the API never planned — direct program calls,
 * wallet-broadcast transactions and plain token donations — through the same reconciler.
 * The cursor advances only after a signature's facts are committed; replays are deduplicated
 * by (network, signature), so a crash between the two steps is harmless.
 */
export class Indexer {
  private readonly db: Db;
  private readonly chain: Chain;
  private readonly reconciler: Reconciler;

  constructor(db: Db, chain: Chain, reconciler: Reconciler) {
    this.db = db;
    this.chain = chain;
    this.reconciler = reconciler;
  }

  async syncAll(): Promise<void> {
    const vaults = await this
      .db`SELECT address FROM vaults ORDER BY created_at`;
    for (const vault of vaults) {
      // oxlint-disable-next-line no-await-in-loop -- vaults sync one at a time so reconciler transactions never race each other
      await this.syncVault(vault.address);
    }
  }

  async syncVault(vault: string): Promise<void> {
    const [row] = await this
      .db`SELECT address, token_account FROM vaults WHERE address = ${vault}`;
    if (!row) {
      return;
    }
    await this.syncAddress(row.address);
    await this.syncAddress(row.token_account);
  }

  private async syncAddress(address: string): Promise<void> {
    const name = `${this.chain.network}:${address}`;
    const [cursor] = await this
      .db`SELECT signature, slot FROM cursors WHERE name = ${name}`;
    let pending: SignatureInfo[];
    try {
      pending = await this.newerThan(address, {
        until: cursor?.signature ?? undefined,
      });
    } catch (error) {
      if (!cursor || !/not found/iu.test((error as Error).message)) {
        throw error;
      }
      // The node pruned the cursor's transaction. Page back by slot instead; anything already
      // processed is deduplicated by (network, signature).
      const floor = BigInt(cursor.slot ?? 0);
      pending = await this.newerThan(address, { floor });
    }
    // Oldest first, so the cursor only ever moves forward over committed work.
    for (const info of pending.toReversed()) {
      // oxlint-disable-next-line no-await-in-loop -- signatures must be processed oldest-first, one at a time
      const result = await this.reconciler.processSignature(info.signature);
      if (result === "not_found") {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- the cursor advances only after this signature's facts are committed
      await this.db`
        INSERT INTO cursors (name, signature, slot) VALUES (${name}, ${info.signature}, ${info.slot.toString()})
        ON CONFLICT (name) DO UPDATE SET signature = EXCLUDED.signature, slot = EXCLUDED.slot, updated_at = now()`;
    }
  }

  /** Signatures newer than `until` (exclusive) or at/after `floor`, newest first. */
  private async newerThan(
    address: string,
    bound: { until?: string; floor?: bigint }
  ): Promise<SignatureInfo[]> {
    const { floor, until } = bound;
    const collected: SignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- pagination: each page starts before the previous page's last signature
      const page = await this.chain.getSignaturesForAddress(address, {
        before,
        limit: PAGE,
        until,
      });
      const kept =
        floor === undefined ? page : page.filter((info) => info.slot >= floor);
      collected.push(...kept);
      const last = page.at(-1);
      if (!last || page.length < PAGE || kept.length < page.length) {
        return collected;
      }
      before = last.signature;
    }
  }
}
