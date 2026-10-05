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
  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
    private readonly reconciler: Reconciler,
  ) {}

  async syncAll(): Promise<void> {
    const vaults = await this.db`SELECT address FROM vaults ORDER BY created_at`;
    for (const vault of vaults) await this.syncVault(vault.address);
  }

  async syncVault(vault: string): Promise<void> {
    const [row] = await this.db`SELECT address, token_account FROM vaults WHERE address = ${vault}`;
    if (!row) return;
    await this.syncAddress(row.address);
    await this.syncAddress(row.token_account);
  }

  private async syncAddress(address: string): Promise<void> {
    const name = `${this.chain.network}:${address}`;
    const [cursor] = await this.db`SELECT signature FROM cursors WHERE name = ${name}`;
    const pending: SignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.chain.getSignaturesForAddress(address, {
        until: cursor?.signature ?? undefined,
        before,
        limit: PAGE,
      });
      pending.push(...page);
      if (page.length < PAGE) break;
      before = page.at(-1)!.signature;
    }
    // Oldest first, so the cursor only ever moves forward over committed work.
    for (const info of pending.reverse()) {
      const result = await this.reconciler.processSignature(info.signature);
      if (result === "not_found") return;
      await this.db`
        INSERT INTO cursors (name, signature, slot) VALUES (${name}, ${info.signature}, ${info.slot.toString()})
        ON CONFLICT (name) DO UPDATE SET signature = EXCLUDED.signature, slot = EXCLUDED.slot, updated_at = now()`;
    }
  }
}
