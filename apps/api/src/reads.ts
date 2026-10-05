import { loanView, type LoanState } from "@forge/sdk";

import type { Institution } from "./auth";
import type { Chain } from "./chain";
import type { Db } from "./db";
import { notFound } from "./http";
import { toView, type AttemptRow, type OperationRow } from "./operations";

const now = () => BigInt(Math.floor(Date.now() / 1000));

function loanWithView(row: Record<string, unknown>) {
  if (!row.onchain || !row.state) return { ...row, view: { status: "pending" } };
  return {
    ...row,
    view: loanView(
      {
        state: row.state as LoanState,
        offerExpiry: BigInt(row.offer_expiry as string),
        disbursedAt: BigInt((row.disbursed_at as string) ?? 0),
        termSeconds: BigInt(row.term_seconds as string),
      },
      now(),
    ),
  };
}

export class Reads {
  constructor(
    private readonly db: Db,
    private readonly chain: Chain,
  ) {}

  async vaults(institution: Institution) {
    return this.db`SELECT * FROM vaults WHERE institution_id = ${institution.id} ORDER BY created_at`;
  }

  async vault(institution: Institution, vault: string) {
    const [row] = await this.db`
      SELECT * FROM vaults WHERE address = ${vault} AND institution_id = ${institution.id}`;
    if (!row) throw notFound("Vault");
    return row;
  }

  async loans(institution: Institution, vault: string) {
    await this.vault(institution, vault);
    const rows = await this.db`SELECT * FROM loans WHERE vault = ${vault} ORDER BY created_at`;
    return rows.map(loanWithView);
  }

  async loan(institution: Institution, loan: string) {
    const [row] = await this.db`
      SELECT l.* FROM loans l JOIN vaults v ON v.address = l.vault
      WHERE l.address = ${loan} AND v.institution_id = ${institution.id}`;
    if (!row) throw notFound("Loan");
    return loanWithView(row);
  }

  async withdrawals(institution: Institution, vault: string) {
    await this.vault(institution, vault);
    return this.db`SELECT * FROM withdrawals WHERE vault = ${vault} ORDER BY created_at`;
  }

  async operations(institution: Institution, vault: string) {
    await this.vault(institution, vault);
    const operations = (await this.db`
      SELECT * FROM operations WHERE vault = ${vault} AND institution_id = ${institution.id}
      ORDER BY created_at DESC LIMIT 200`) as OperationRow[];
    const ids = operations.map((o) => o.id);
    const attempts = ids.length
      ? ((await this.db`SELECT * FROM tx_attempts WHERE operation_id IN ${this.db(ids)}
                         ORDER BY attempt_no`) as AttemptRow[])
      : [];
    return operations.map((o) =>
      toView(o, attempts.filter((a) => a.operation_id === o.id), this.chain.network),
    );
  }

  /** Finalized postings, per-account balances, open exceptions and a cash reconciliation. */
  async statement(institution: Institution, vault: string) {
    const row = await this.vault(institution, vault);
    const postings = await this.db`
      SELECT p.*, e.kind AS event_kind, e.operation_id
      FROM postings p LEFT JOIN chain_events e ON e.id = p.event_id
      WHERE p.vault = ${vault} ORDER BY p.slot, p.id`;
    const balances = await this.db`
      SELECT account, sum(debit)::text AS debit, sum(credit)::text AS credit,
             (sum(debit) - sum(credit))::text AS balance
      FROM postings WHERE vault = ${vault} GROUP BY account ORDER BY account`;
    const exceptions = await this.db`
      SELECT * FROM exceptions WHERE vault = ${vault} ORDER BY id`;
    const ledgerCash = BigInt(
      (balances.find((b: { account: string }) => b.account === "vault_cash")?.balance as string) ?? "0",
    );
    const [totals] = await this.db`
      SELECT coalesce(sum(debit), 0)::text AS debits, coalesce(sum(credit), 0)::text AS credits
      FROM postings WHERE vault = ${vault}`;
    return {
      vault,
      postings,
      balances,
      exceptions,
      balanced: totals.debits === totals.credits,
      reconciliation: {
        ledgerCash: ledgerCash.toString(),
        chainCash: row.cash,
        syncedSlot: row.synced_slot,
        matches: row.cash !== null && BigInt(row.cash) === ledgerCash,
      },
    };
  }

  async events(institution: Institution, after: number) {
    return this.db`
      SELECT id, event_id, type, payload, attempts, delivered_at, created_at FROM webhook_outbox
      WHERE institution_id = ${institution.id} AND id > ${after} ORDER BY id LIMIT 500`;
  }

  async status() {
    const [worker] = await this.db`
      SELECT worker_id, seen_at, details FROM worker_heartbeats ORDER BY seen_at DESC LIMIT 1`;
    let finalizedHeight: string | null = null;
    try {
      finalizedHeight = (await this.chain.getBlockHeight("finalized")).toString();
    } catch {
      finalizedHeight = null;
    }
    return { network: this.chain.network, finalizedHeight, worker: worker ?? null };
  }
}
