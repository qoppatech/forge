// Regressions for the 2026-10 security audit: each test reproduces a confirmed finding's
// trigger and asserts the fixed behaviour.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  FORGE_PROGRAM_ADDRESS,
  MEMO_PROGRAM_ADDRESS,
  buildForgeInstruction,
  compileIntentTransaction,
  encodeWireTransaction,
  signPlanTransaction,
} from "@forge/sdk";
import type { FundVaultIntent, ProposeLoanIntent } from "@forge/sdk";
import { generateKeyPair, getAddressFromPublicKey } from "@solana/kit";

import type { ChainInstruction, TokenBalanceChange } from "../src/chain";
import { MAX_PENDING_VAULTS } from "../src/operations";
import { randomAddress } from "./fake-chain";
import { setup } from "./harness";
import type { Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h.close();
});

async function newSigner() {
  const pair = await generateKeyPair();
  return { address: await getAddressFromPublicKey(pair.publicKey), pair };
}

const memoInstruction = (text: string): ChainInstruction => ({
  accounts: [],
  data: new TextEncoder().encode(text),
  index: 0,
  innerIndex: -1,
  programAddress: MEMO_PROGRAM_ADDRESS,
});

/** Lands a finalized transaction exactly as given (raw instruction bytes are not re-encoded). */
function inject(tx: {
  feePayer: string;
  instructions: ChainInstruction[];
  watch: string[];
  err?: unknown;
  tokenBalances?: TokenBalanceChange[];
}): string {
  const signature = randomAddress();
  const err = tx.err ?? null;
  h.chain.slot += 1n;
  h.chain.statuses.set(signature, {
    confirmationStatus: "finalized",
    err,
    slot: h.chain.slot,
  });
  h.chain.transactions.set(signature, {
    blockTime: 1_900_000_000n,
    blockhash: randomAddress(),
    err,
    feePayer: tx.feePayer,
    instructions: tx.instructions,
    logs: [],
    messageHash: signature,
    signature,
    slot: h.chain.slot,
    tokenBalances: tx.tokenBalances ?? [],
  });
  for (const address of tx.watch) {
    h.chain.history.set(address, [
      { err, signature, slot: h.chain.slot },
      ...(h.chain.history.get(address) ?? []),
    ]);
  }
  return signature;
}

const deposit = (
  vault: { vault: string; vaultTokenAccount: string },
  amount: bigint
): TokenBalanceChange => ({
  account: vault.vaultTokenAccount,
  mint: h.accounts.mint,
  owner: vault.vault,
  post: amount,
  pre: 0n,
});

async function errors() {
  const [row] =
    await h.db`SELECT details FROM worker_heartbeats WHERE worker_id = 'w1'`;
  return row?.details.errors ?? {};
}

describe("third-party chain data", () => {
  test("a malformed operation memo is ignored and does not stop indexing", async () => {
    const { intent: first } = await h.createVault("a");
    const { intent: later } = await h.createVault("b");
    inject({
      err: { InstructionError: [0, "MissingRequiredSignature"] },
      feePayer: randomAddress(),
      instructions: [memoInstruction(`forge:op:${"-".repeat(36)}:1`)],
      watch: [first.vault],
    });
    const donation = randomAddress();
    h.chain.landRaw({
      feePayer: randomAddress(),
      signature: donation,
      tokenBalances: [deposit(later, 700n)],
    });
    await h.worker().tick();
    const [seen] =
      await h.db`SELECT count(*)::int AS n FROM chain_transactions WHERE signature = ${donation}`;
    expect(seen.n).toBe(1);
    expect(await errors()).toEqual({});
  });

  test("a vault that cannot be indexed holds back only itself, not other vaults or their expiry", async () => {
    const { intent: poisoned } = await h.createVault("a");
    const { intent: healthy } = await h.createVault("b");
    const poison = inject({
      feePayer: randomAddress(),
      instructions: [],
      watch: [poisoned.vault],
    });
    const getTransaction = h.chain.getTransaction.bind(h.chain);
    h.chain.getTransaction = (signature: string) =>
      signature === poison
        ? Promise.reject(new Error("poisoned record"))
        : getTransaction(signature);
    const donation = randomAddress();
    h.chain.landRaw({
      feePayer: randomAddress(),
      signature: donation,
      tokenBalances: [deposit(healthy, 700n)],
    });
    const fund = { amount: "5", source: h.accounts.source };
    const { body: stuck } = await h.api(
      "POST",
      `/v1/vaults/${poisoned.vault}/fund`,
      fund
    );
    const { body: other } = await h.api(
      "POST",
      `/v1/vaults/${healthy.vault}/fund`,
      fund
    );
    h.chain.expireAll();
    await h.worker().tick();

    const [seen] =
      await h.db`SELECT count(*)::int AS n FROM chain_transactions WHERE signature = ${donation}`;
    expect(seen.n).toBe(1);
    const { body: expired } = await h.api("GET", `/v1/operations/${other.id}`);
    expect(expired.status).toBe("expired");
    const { body: held } = await h.api("GET", `/v1/operations/${stuck.id}`);
    expect(held.status).toBe("prepared");
    expect(Object.keys(await errors())).toContain("indexer");
  });

  test("a third party's failing transaction that copies an operation memo does not fail the operation", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      { amount: "9", source: h.accounts.source }
    );
    await h.sign(fund, h.roles.treasury);
    const legitimate = await h.lastSent();
    const outsider = await newSigner();
    const forged = compileIntentTransaction(
      { ...(fund.intent as FundVaultIntent), treasury: outsider.address },
      await h.chain.getLatestBlockhash(),
      { memo: fund.plan.memo }
    );
    await h.chain.land(
      await signPlanTransaction(encodeWireTransaction(forged), [outsider.pair]),
      { err: { InstructionError: [1, { Custom: 2001 }] } }
    );
    await h.worker().tick();
    const { body: untouched } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(untouched.status).toBe("submitted");
    expect(untouched.attempts[0].status).toBe("live");

    await h.chain.land(legitimate);
    await h.db`UPDATE tx_attempts SET next_check_at = now()`;
    await h.worker().tick();
    const { body: applied } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(applied.status).toBe("finalized");
  });

  test("the operation's own signer re-signing with the memo still records a failure", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      { amount: "9", source: h.accounts.source }
    );
    const resigned = compileIntentTransaction(
      fund.intent as FundVaultIntent,
      await h.chain.getLatestBlockhash(),
      { memo: fund.plan.memo }
    );
    await h.chain.land(
      await signPlanTransaction(encodeWireTransaction(resigned), [
        h.roles.treasury.pair,
      ]),
      { err: { InstructionError: [1, { Custom: 1 }] } }
    );
    await h.worker().tick();
    const { body: failed } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(failed.status).toBe("failed");
  });

  test("an executed Forge instruction with trailing bytes is recorded like the canonical one", async () => {
    const { intent } = await h.createVault();
    const fund: FundVaultIntent = {
      amount: "300",
      kind: "fund_vault",
      mint: h.accounts.mint,
      source: h.accounts.source,
      treasury: h.roles.treasury.address,
      vault: intent.vault,
      vaultTokenAccount: intent.vaultTokenAccount,
    };
    const ix = buildForgeInstruction(fund);
    h.setVault(intent, {}, 300n);
    const signature = inject({
      feePayer: h.roles.treasury.address,
      instructions: [
        {
          accounts: (ix.accounts ?? []).map((a) => a.address),
          data: new Uint8Array([...(ix.data ?? []), 0xde, 0xad]),
          index: 0,
          innerIndex: -1,
          programAddress: FORGE_PROGRAM_ADDRESS,
        },
      ],
      tokenBalances: [deposit(intent, 300n)],
      watch: [intent.vault, intent.vaultTokenAccount],
    });
    await h.worker().tick();
    const events =
      await h.db`SELECT kind FROM chain_events WHERE signature = ${signature}`;
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(["fund_vault"]);
    const [exceptions] =
      await h.db`SELECT count(*)::int AS n FROM exceptions WHERE signature = ${signature}`;
    expect(exceptions.n).toBe(0);
  });

  test("one transaction depositing into two vaults records an exception for each", async () => {
    const { intent: a } = await h.createVault("a");
    const { intent: b } = await h.createVault("b");
    h.setVault(a, {}, 1n);
    h.setVault(b, {}, 50n);
    const signature = randomAddress();
    h.chain.landRaw({
      feePayer: randomAddress(),
      signature,
      tokenBalances: [deposit(a, 1n), deposit(b, 50n)],
    });
    await h.worker().tick();
    const rows =
      await h.db`SELECT vault FROM exceptions WHERE signature = ${signature} ORDER BY vault`;
    expect(rows.map((r: { vault: string }) => r.vault)).toEqual(
      [a.vault, b.vault].toSorted()
    );
    const statements = await Promise.all(
      [a.vault, b.vault].map((vault) =>
        h.api("GET", `/v1/vaults/${vault}/statement`)
      )
    );
    for (const { body } of statements) {
      expect(body.reconciliation.matches).toBe(true);
    }
  });
});

describe("operation lifecycle", () => {
  test("registry rows follow the terms that landed; a reference cannot be re-planned with other terms", async () => {
    const { intent } = await h.createVault();
    const loanBody = {
      approver: h.roles.approverA.address,
      borrower: h.roles.borrower.address,
      destination: h.accounts.borrowerTokens,
      offerExpiry: String(Math.floor(Date.now() / 1000) + 3600),
      principal: "100",
      reference: "LN-1",
      termRateBps: 0,
      termSeconds: "60",
    };
    const path = `/v1/vaults/${intent.vault}/loans`;
    const { body: loan } = await h.api("POST", path, loanBody);
    const changed = await h.api("POST", path, {
      ...loanBody,
      principal: "4000000000",
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("reference_conflict");
    const retry = await h.api("POST", path, { ...loanBody });
    expect(retry.status).toBe(201);

    // One approver alone lands a proposal at the same address with other terms.
    const chainTerms: ProposeLoanIntent = {
      ...(loan.intent as ProposeLoanIntent),
      approver: h.roles.approverB.address,
      borrower: randomAddress(),
      destination: randomAddress(),
      principal: "4999999999",
      termSeconds: "31536000",
    };
    const direct = compileIntentTransaction(
      chainTerms,
      await h.chain.getLatestBlockhash()
    );
    await h.chain.land(
      await signPlanTransaction(encodeWireTransaction(direct), [
        h.roles.approverB.pair,
      ])
    );
    h.setLoan(chainTerms.loan, {
      approvals: [false, false],
      borrower: chainTerms.borrower,
      bump: 254,
      destination: chainTerms.destination,
      disbursedAt: 0n,
      fixedInterest: 0n,
      fixedPayoff: 4_999_999_999n,
      loanId: chainTerms.loanId,
      offerExpiry: BigInt(chainTerms.offerExpiry),
      principal: 4_999_999_999n,
      proposedAt: 1n,
      repaidAt: 0n,
      state: "Proposed",
      termRateBps: 0,
      termSeconds: 31_536_000n,
      vault: intent.vault,
    });
    await h.worker().tick();
    const { body: row } = await h.api("GET", `/v1/loans/${chainTerms.loan}`);
    expect(row.borrower).toBe(chainTerms.borrower);
    expect(String(row.principal)).toBe("4999999999");
    expect(String(row.term_seconds)).toBe("31536000");
  });

  test("concurrent vault creations with one reference register exactly one vault", async () => {
    const body = (treasury: string) => ({
      approvers: [h.roles.approverA.address, h.roles.approverB.address],
      mint: h.accounts.mint,
      outstandingLimit: "10",
      perLoanLimit: "5",
      reference: "race",
      treasury,
      treasuryDestination: h.accounts.treasuryDestination,
    });
    const otherTreasury = await newSigner();
    const results = await Promise.all([
      h.api("POST", "/v1/vaults", body(h.roles.treasury.address)),
      h.api("POST", "/v1/vaults", body(otherTreasury.address)),
    ]);
    expect(results.map((r) => r.status).toSorted()).toEqual([201, 409]);
    const [{ n }] =
      await h.db`SELECT count(*)::int AS n FROM vaults WHERE vault_ref = 'race'`;
    expect(n).toBe(1);
  });

  test("an operation applied by another transaction can no longer be signed or rebroadcast", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      { amount: "21", source: h.accounts.source }
    );
    // A wallet rebuilt the plan without the memo and broadcast it itself.
    const rebuilt = compileIntentTransaction(
      fund.intent as FundVaultIntent,
      await h.chain.getLatestBlockhash()
    );
    await h.chain.land(
      await signPlanTransaction(encodeWireTransaction(rebuilt), [
        h.roles.treasury.pair,
      ])
    );
    await h.worker().tick();
    const { body: applied } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(applied.status).toBe("finalized");
    expect(applied.plan).toBeNull();
    const late = await h.sign(fund, h.roles.treasury);
    expect(late.status).toBe(409);

    // Live attempt variant: the rebuild lands after the plan was signed and broadcast.
    const { body: live } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      { amount: "23", source: h.accounts.source }
    );
    await h.sign(live, h.roles.treasury);
    const rebuiltLive = compileIntentTransaction(
      live.intent as FundVaultIntent,
      await h.chain.getLatestBlockhash()
    );
    await h.chain.land(
      await signPlanTransaction(encodeWireTransaction(rebuiltLive), [
        h.roles.treasury.pair,
      ])
    );
    const worker = h.worker();
    await worker.indexer.syncAll();
    await h.db`UPDATE tx_attempts SET next_check_at = now(), last_sent_at = now() - interval '10 seconds'`;
    const sends = h.chain.sent.length;
    await worker.tracker.tick();
    expect(h.chain.sent.length).toBe(sends);
  });

  test("an attempt seen at processed and then dropped is rebroadcast and can expire", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      { amount: "5", source: h.accounts.source }
    );
    await h.sign(fund, h.roles.treasury);
    const signature = await h.chain.land(await h.lastSent(), {
      commitment: "processed",
    });
    const worker = h.worker();
    await worker.tick();
    h.chain.prune([signature]);
    await h.db`UPDATE tx_attempts SET next_check_at = now(), last_sent_at = now() - interval '10 seconds'`;
    const sends = h.chain.sent.length;
    await worker.tick();
    expect(h.chain.sent.length).toBe(sends + 1);

    h.chain.expireAll();
    await h.db`UPDATE tx_attempts SET next_check_at = now(), lease_until = NULL`;
    await worker.tick();
    const { body: expired } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(expired.status).toBe("expired");
    const again = await h.api("POST", `/v1/operations/${fund.id}/prepare`);
    expect(again.status).toBe(201);
  });
});

describe("shared resources", () => {
  test("pending vault registrations are capped and stop being polled once they expire", async () => {
    const create = (reference: string) =>
      h.api("POST", "/v1/vaults", {
        approvers: [h.roles.approverA.address, h.roles.approverB.address],
        mint: h.accounts.mint,
        outstandingLimit: "10",
        perLoanLimit: "5",
        reference,
        treasury: h.roles.treasury.address,
        treasuryDestination: h.accounts.treasuryDestination,
      });
    for (let i = 0; i < MAX_PENDING_VAULTS; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- registrations are counted one after another
      const created = await create(`p-${i}`);
      expect(created.status).toBe(201);
    }
    const over = await create("over");
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("too_many_pending_vaults");

    h.chain.expireAll();
    const worker = h.worker();
    await worker.tracker.expireUnsigned();
    let polled = 0;
    const getSignatures = h.chain.getSignaturesForAddress.bind(h.chain);
    h.chain.getSignaturesForAddress = (address, options) => {
      polled += 1;
      return getSignatures(address, options);
    };
    await worker.indexer.syncAll();
    expect(polled).toBe(0);
    const afterExpiry = await create("after-expiry");
    expect(afterExpiry.status).toBe(201);
  });

  test("webhook delivery does not follow a receiver's redirect", async () => {
    let internalHits = 0;
    const internal = Bun.serve({
      fetch: () => {
        internalHits += 1;
        return new Response("ok");
      },
      port: 0,
    });
    const receiver = Bun.serve({
      fetch: () =>
        new Response(null, {
          headers: { location: `http://127.0.0.1:${internal.port}/admin` },
          status: 307,
        }),
      port: 0,
    });
    await h.db`UPDATE institutions SET webhook_url = ${`http://127.0.0.1:${receiver.port}/hook`} WHERE id = ${h.bank.institution.id}`;
    await h.createVault();
    await h.worker().webhooks.deliver();
    receiver.stop(true);
    internal.stop(true);
    expect(internalHits).toBe(0);
    const [row] =
      await h.db`SELECT delivered_at, last_error FROM webhook_outbox LIMIT 1`;
    expect(row.delivered_at).toBeNull();
    expect(row.last_error).toBe("HTTP 307");
  });

  test("request bodies over 64 KiB are refused, counted in bytes", async () => {
    const post = (body: string) =>
      fetch(`http://127.0.0.1:${h.server.port}/v1/vaults`, {
        body,
        headers: {
          authorization: `Bearer ${h.bank.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        method: "POST",
      });
    const ascii = await post("x".repeat(100 * 1024));
    expect(ascii.status).toBe(413);
    // 30,000 characters, 90,000 bytes.
    const multibyte = await post(
      JSON.stringify({ reference: "€".repeat(30_000) })
    );
    expect(multibyte.status).toBe(413);
  });
});
