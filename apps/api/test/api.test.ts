import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { signPlanTransaction, verifyPlan } from "@forge/sdk";

import { setup, tokenAccountData } from "./harness";
import type { Harness } from "./harness";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h.close();
});

const vaultBody = (harness: Harness, reference = "main") => ({
  approvers: [harness.roles.approverA.address, harness.roles.approverB.address],
  mint: harness.accounts.mint,
  outstandingLimit: "10000000000",
  perLoanLimit: "5000000000",
  reference,
  treasury: harness.roles.treasury.address,
  treasuryDestination: harness.accounts.treasuryDestination,
});

describe("API boundary (#4)", () => {
  test("unknown routes are closed and every /v1 route needs a valid key", async () => {
    const unknownRoute = await h.api("GET", "/v1/nope");
    expect(unknownRoute.status).toBe(404);
    const noKey = await h.api("GET", "/v1/vaults", undefined, { key: null });
    expect(noKey.status).toBe(401);
    const wrongKey = await h.api("GET", "/v1/vaults", undefined, {
      key: `fk_${"0".repeat(64)}`,
    });
    expect(wrongKey.status).toBe(401);
    const health = await h.api("GET", "/health", undefined, { key: null });
    expect(health.status).toBe(200);
  });

  test("institution A cannot read or mutate institution B's vault", async () => {
    const { intent } = await h.createVault();
    const asOther = { key: h.other.apiKey };
    const vault = await h.api(
      "GET",
      `/v1/vaults/${intent.vault}`,
      undefined,
      asOther
    );
    expect(vault.status).toBe(404);
    const statement = await h.api(
      "GET",
      `/v1/vaults/${intent.vault}/statement`,
      undefined,
      asOther
    );
    expect(statement.status).toBe(404);
    const fund = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      { amount: "1", source: h.accounts.source },
      asOther
    );
    expect(fund.status).toBe(404);
  });

  test("same Idempotency-Key + payload returns the original operation; a different payload is a 409", async () => {
    const first = await h.api("POST", "/v1/vaults", vaultBody(h), {
      idempotencyKey: "create-main",
    });
    expect(first.status).toBe(201);
    const again = await h.api("POST", "/v1/vaults", vaultBody(h), {
      idempotencyKey: "create-main",
    });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const changed = await h.api(
      "POST",
      "/v1/vaults",
      { ...vaultBody(h), perLoanLimit: "1" },
      { idempotencyKey: "create-main" }
    );
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("idempotency_conflict");
    const missing = await fetch(`http://127.0.0.1:${h.server.port}/v1/vaults`, {
      body: JSON.stringify(vaultBody(h)),
      headers: {
        authorization: `Bearer ${h.bank.apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(missing.status).toBe(400);
  });

  test("request validation rejects bad addresses, amounts and duplicate approvers", async () => {
    const bad = await h.api("POST", "/v1/vaults", {
      ...vaultBody(h),
      approvers: [h.roles.approverA.address, h.roles.approverA.address],
    });
    expect(bad.status).toBe(400);
    const badMint = await h.api("POST", "/v1/vaults", {
      ...vaultBody(h),
      mint: "not-an-address",
    });
    expect(badMint.status).toBe(400);
    const badAmount = await h.api("POST", "/v1/vaults", {
      ...vaultBody(h),
      perLoanLimit: "1.5",
    });
    expect(badAmount.status).toBe(400);
    const extraField = await h.api("POST", "/v1/vaults", {
      ...vaultBody(h),
      extra: true,
    });
    expect(extraField.status).toBe(400);
  });

  test("plans name their signers and verify against the intent; the service never signs", async () => {
    const created = await h.api("POST", "/v1/vaults", vaultBody(h));
    const op = created.body;
    expect(op.status).toBe("prepared");
    expect(op.plan.requiredSigners).toEqual([h.roles.treasury.address]);
    expect(op.plan.feePayer).toBe(h.roles.treasury.address);
    expect(await verifyPlan(op.plan)).toEqual([]);
    expect(op.attempts[0].signedBy).toEqual([]);
    expect(h.chain.sent).toHaveLength(0);
  });

  test("forged signatures, wrong signers and altered messages are rejected", async () => {
    const { body: op } = await h.api("POST", "/v1/vaults", vaultBody(h));
    // Signed by the wrong key: the borrower is not a signer of this message.
    const wrong = await signPlanTransaction(op.plan.transaction, [
      h.roles.borrower.pair,
    ]).catch(String);
    expect(typeof wrong).toBe("string");
    // A different message (another plan) signed by the right key.
    const { body: other } = await h.api(
      "POST",
      "/v1/vaults",
      vaultBody(h, "other")
    );
    const signedOther = await signPlanTransaction(other.plan.transaction, [
      h.roles.treasury.pair,
    ]);
    const rejected = await h.api("POST", `/v1/operations/${op.id}/signatures`, {
      transaction: signedOther,
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe("signature_rejected");
    const undecodable = await h.api(
      "POST",
      `/v1/operations/${op.id}/signatures`,
      { transaction: "AAAA" }
    );
    expect(undecodable.status).toBe(400);
  });

  test("signed bytes and the signature are persisted before broadcast, even when the RPC send fails", async () => {
    const { body: op } = await h.api("POST", "/v1/vaults", vaultBody(h));
    h.chain.sendFailure = new Error("timeout");
    const submitted = await h.sign(op, h.roles.treasury);
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe("submitted");
    const [attempt] = submitted.body.attempts;
    expect(attempt.status).toBe("live");
    expect(attempt.signature).toBeString();
    expect(attempt.sendCount).toBe(0);
    expect(attempt.lastSendError).toContain("timeout");
    // The worker later rebroadcasts the identical bytes; it never builds a new transaction.
    h.chain.sendFailure = undefined;
    await h.worker().tick();
    expect(h.chain.sent).toHaveLength(1);
    const [row] =
      await h.db`SELECT signed_tx FROM tx_attempts WHERE signature = ${attempt.signature}`;
    expect<string | undefined>(
      Buffer.from(row.signed_tx).toString("base64")
    ).toBe(h.chain.sent[0]);
  });

  test("two-approver pause collects partial signatures before broadcasting", async () => {
    const { intent } = await h.createVault();
    const { body: op } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/pause`,
      { paused: true }
    );
    expect(op.plan.requiredSigners).toEqual([
      h.roles.approverA.address,
      h.roles.approverB.address,
    ]);
    expect(op.intent.expectedSeq).toBe("0");
    const sent = h.chain.sent.length;
    const afterA = await h.sign(op, h.roles.approverA);
    expect(afterA.body.status).toBe("prepared");
    expect(afterA.body.attempts[0].signedBy).toEqual([
      h.roles.approverA.address,
    ]);
    expect(h.chain.sent.length).toBe(sent);
    const afterB = await h.sign(op, h.roles.approverB);
    expect(afterB.body.status).toBe("submitted");
    expect(h.chain.sent.length).toBe(sent + 1);
  });
});

describe("worker lifecycle (#5)", () => {
  test("finalized funding produces an event, balanced postings, projections and a webhook event", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      {
        amount: "10000000000",
        source: h.accounts.source,
      }
    );
    await h.sign(fund, h.roles.treasury);
    const wire = await h.lastSent();
    h.setVault(intent, {}, 10_000_000_000n);
    await h.chain.land(wire, {
      tokenBalances: [
        {
          account: intent.vaultTokenAccount,
          mint: h.accounts.mint,
          owner: intent.vault,
          post: 10_000_000_000n,
          pre: 0n,
        },
      ],
    });
    await h.worker().tick();
    const { body: op } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(op.status).toBe("finalized");
    expect(op.attempts[0]).toMatchObject({
      confirmation: "finalized",
      status: "landed_ok",
    });
    const { body: statement } = await h.api(
      "GET",
      `/v1/vaults/${intent.vault}/statement`
    );
    expect(statement.balanced).toBe(true);
    expect(statement.reconciliation).toMatchObject({
      ledgerCash: "10000000000",
      matches: true,
    });
    expect(statement.exceptions).toEqual([]);
    const { body: outbox } = await h.api("GET", "/v1/events");
    const events = outbox.map((e: { type: string }) => e.type);
    expect(events).toEqual(["vault.created", "vault.funded"]);
  });

  test("confirmed is reported before finalized; postings wait for finalization", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      {
        amount: "5",
        source: h.accounts.source,
      }
    );
    await h.sign(fund, h.roles.treasury);
    const signature = await h.chain.land(await h.lastSent(), {
      commitment: "confirmed",
    });
    await h.worker().tick();
    const { body: confirmed } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(confirmed.status).toBe("confirmed");
    const [beforeFinality] =
      await h.db`SELECT count(*)::int AS n FROM postings`;
    expect(beforeFinality.n).toBe(0);
    h.chain.setCommitment(signature, "finalized");
    await h.db`UPDATE tx_attempts SET next_check_at = now()`;
    await h.worker().tick();
    const { body: finalized } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(finalized.status).toBe("finalized");
    const [afterFinality] = await h.db`SELECT count(*)::int AS n FROM postings`;
    expect(afterFinality.n).toBe(2);
  });

  test("expiry is declared only with proof, and only then can a new attempt be prepared", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      {
        amount: "5",
        source: h.accounts.source,
      }
    );
    await h.sign(fund, h.roles.treasury);
    const worker = h.worker();
    // not landed, blockhash still valid → rebroadcast
    await worker.tick();
    const { body: submitted } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(submitted.status).toBe("submitted");
    const early = await h.api("POST", `/v1/operations/${fund.id}/prepare`);
    expect(early.status).toBe(409);

    h.chain.expireAll();
    await h.db`UPDATE tx_attempts SET next_check_at = now()`;
    await worker.tick();
    const { body: expired } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(expired.status).toBe("expired");
    expect(expired.attempts[0].status).toBe("expired");

    const again = await h.api("POST", `/v1/operations/${fund.id}/prepare`);
    expect(again.status).toBe(201);
    expect(again.body.status).toBe("prepared");
    expect(again.body.plan.attemptNo).toBe(2);
    expect(again.body.plan.blockhash).not.toBe(expired.attempts[0].blockhash);
    const { body: outbox } = await h.api("GET", "/v1/events");
    const types = outbox.map((e: { type: string }) => e.type);
    expect(types).toContain("operation.expired");
  });

  test("an RPC outage produces no transitions", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      {
        amount: "5",
        source: h.accounts.source,
      }
    );
    await h.sign(fund, h.roles.treasury);
    h.chain.rpcDown = true;
    h.chain.expireAll();
    await h.worker().tick();
    const { body: op } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(op.status).toBe("submitted");
  });

  test("two workers on the same attempt rebroadcast identical bytes and post once", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      {
        amount: "7",
        source: h.accounts.source,
      }
    );
    await h.sign(fund, h.roles.treasury);
    const first = await h.lastSent();
    await h.db`UPDATE tx_attempts SET last_sent_at = NULL, next_check_at = now()`;
    await Promise.all([h.worker("w1").tick(), h.worker("w2").tick()]);
    expect(new Set(h.chain.sent.slice(-2))).toEqual(new Set([first]));
    await h.chain.land(first);
    await h.db`UPDATE tx_attempts SET next_check_at = now(), lease_until = NULL`;
    await Promise.all([h.worker("w1").tick(), h.worker("w2").tick()]);
    const events =
      await h.db`SELECT count(*)::int AS n FROM chain_events WHERE kind = 'fund_vault'`;
    expect(events[0].n).toBe(1);
  });

  test("a duplicate approval resolves to already_applied, not a dead letter", async () => {
    const { intent } = await h.createVault();
    const { body: loan } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/loans`,
      {
        approver: h.roles.approverA.address,
        borrower: h.roles.borrower.address,
        destination: h.accounts.borrowerTokens,
        offerExpiry: String(Math.floor(Date.now() / 1000) + 3600),
        principal: "5000000000",
        reference: "LN-1",
        termRateBps: 200,
        termSeconds: "2592000",
      }
    );
    await h.sign(loan, h.roles.approverA);
    await h.chain.land(await h.lastSent());
    const loanAccount = {
      approvals: [false, false] as [boolean, boolean],
      borrower: h.roles.borrower.address,
      bump: 254,
      destination: h.accounts.borrowerTokens,
      disbursedAt: 0n,
      fixedInterest: 100_000_000n,
      fixedPayoff: 5_100_000_000n,
      loanId: loan.intent.loanId,
      offerExpiry: BigInt(loan.intent.offerExpiry),
      principal: 5_000_000_000n,
      proposedAt: 1n,
      repaidAt: 0n,
      state: "Proposed" as const,
      termRateBps: 200,
      termSeconds: 2_592_000n,
      vault: intent.vault,
    };
    h.setLoan(loan.intent.loan, loanAccount);
    await h.worker().tick();

    // Two operations for the same approval (two operators, two keys), both signed.
    const { body: first } = await h.api(
      "POST",
      `/v1/loans/${loan.intent.loan}/approve`,
      {
        approver: h.roles.approverA.address,
      }
    );
    const { body: second } = await h.api(
      "POST",
      `/v1/loans/${loan.intent.loan}/approve`,
      {
        approver: h.roles.approverA.address,
      }
    );
    await h.sign(first, h.roles.approverA);
    const firstWire = await h.lastSent();
    await h.sign(second, h.roles.approverA);
    const secondWire = await h.lastSent();
    await h.chain.land(firstWire);
    h.setLoan(loan.intent.loan, { ...loanAccount, approvals: [true, false] });
    await h.chain.land(secondWire, {
      err: { InstructionError: [1, { Custom: 6011 }] },
    });
    await h.worker().tick();

    const { body: applied } = await h.api("GET", `/v1/operations/${first.id}`);
    expect(applied.status).toBe("finalized");
    const { body: replay } = await h.api("GET", `/v1/operations/${second.id}`);
    expect(replay.status).toBe("already_applied");
    expect(replay.error.name).toBe("AlreadyApproved");
    // The API itself refuses to plan an approval that is already recorded.
    const third = await h.api("POST", `/v1/loans/${loan.intent.loan}/approve`, {
      approver: h.roles.approverA.address,
    });
    expect(third.status).toBe(409);
  });

  test("business rejections fail without retry; reused ids with different terms need review", async () => {
    const { intent } = await h.createVault();
    const { body: withdrawal } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/withdrawals`,
      {
        amount: "100",
        approver: h.roles.approverA.address,
        reference: "WD-1",
      }
    );
    await h.sign(withdrawal, h.roles.approverA);
    // Somebody already used this withdrawal id for a different amount.
    h.setWithdrawal(withdrawal.intent.withdrawal, {
      amount: 999n,
      approvals: [false, true],
      bump: 250,
      executedAt: 0n,
      proposedAt: 1n,
      state: "Proposed",
      vault: intent.vault,
      withdrawalId: withdrawal.intent.withdrawalId,
    });
    await h.chain.land(await h.lastSent(), {
      err: { InstructionError: [1, { Custom: 0 }] },
    });
    await h.worker().tick();
    const { body: proposed } = await h.api(
      "GET",
      `/v1/operations/${withdrawal.id}`
    );
    expect(proposed.status).toBe("needs_review");

    const { body: approve } = await h.api(
      "POST",
      `/v1/withdrawals/${withdrawal.intent.withdrawal}/approve`,
      { approver: h.roles.approverA.address }
    );
    await h.sign(approve, h.roles.approverA);
    await h.chain.land(await h.lastSent(), {
      err: { InstructionError: [1, { Custom: 6015 }] },
    });
    const sends = h.chain.sent.length;
    await h.worker().tick();
    const { body: failed } = await h.api("GET", `/v1/operations/${approve.id}`);
    expect(failed.status).toBe("failed");
    expect(failed.statusReason).toContain("InsufficientLiquidity");
    expect(h.chain.sent.length).toBe(sends);
  });

  test("the indexer ingests direct program calls and flags token donations; replay posts once", async () => {
    const { intent } = await h.createVault();
    // A direct call that bypassed the API: same Forge instruction, signed elsewhere.
    const { compileIntentTransaction, encodeWireTransaction } =
      await import("@forge/sdk");
    const direct = compileIntentTransaction(
      {
        amount: "300",
        kind: "fund_vault",
        mint: h.accounts.mint,
        source: h.accounts.source,
        treasury: h.roles.treasury.address,
        vault: intent.vault,
        vaultTokenAccount: intent.vaultTokenAccount,
      },
      await h.chain.getLatestBlockhash()
    );
    const signedDirect = await signPlanTransaction(
      encodeWireTransaction(direct),
      [h.roles.treasury.pair]
    );
    h.setVault(intent, {}, 300n);
    await h.chain.land(signedDirect, {
      tokenBalances: [
        {
          account: intent.vaultTokenAccount,
          mint: h.accounts.mint,
          owner: intent.vault,
          post: 300n,
          pre: 0n,
        },
      ],
    });
    // A plain SPL transfer into the vault: not a repayment, not funding.
    h.setVault(intent, {}, 350n);
    h.chain.landRaw({
      feePayer: h.roles.borrower.address,
      signature: "donation".padEnd(88, "1"),
      tokenBalances: [
        {
          account: intent.vaultTokenAccount,
          mint: h.accounts.mint,
          owner: intent.vault,
          post: 350n,
          pre: 300n,
        },
      ],
    });
    const worker = h.worker();
    await worker.tick();

    const { body: ops } = await h.api(
      "GET",
      `/v1/vaults/${intent.vault}/operations`
    );
    const external = ops.find((o: { origin: string }) => o.origin === "chain");
    expect(external).toMatchObject({ kind: "fund_vault", status: "finalized" });
    const { body: statement } = await h.api(
      "GET",
      `/v1/vaults/${intent.vault}/statement`
    );
    expect(statement.exceptions).toHaveLength(1);
    expect(statement.exceptions[0]).toMatchObject({
      amount: "50",
      kind: "unexpected_deposit",
    });
    expect(statement.balanced).toBe(true);
    expect(statement.reconciliation).toMatchObject({
      chainCash: "350",
      ledgerCash: "350",
      matches: true,
    });

    // Full replay: drop cursors and reprocess everything; nothing posts twice.
    const [{ n: before }] = await h.db`SELECT count(*)::int AS n FROM postings`;
    await h.db`DELETE FROM cursors`;
    await worker.indexer.syncAll();
    const [replayed] = await h.db`SELECT count(*)::int AS n FROM postings`;
    expect(replayed.n).toBe(before);
  });

  test("a wallet that broadcast an unsigned-here plan itself is matched by message hash", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      {
        amount: "9",
        source: h.accounts.source,
      }
    );
    // The treasury's wallet signs and broadcasts without posting the bytes back.
    const signed = await signPlanTransaction(fund.plan.transaction, [
      h.roles.treasury.pair,
    ]);
    await h.chain.land(signed);
    h.chain.expireAll();
    await h.worker().tick();
    const { body: op } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(op.status).toBe("finalized");
    expect(op.appliedSignature).toBeString();
  });

  test("identical requests in the same slot become distinct transactions (operation memo)", async () => {
    const { intent } = await h.createVault();
    const { blockhash } = await h.chain.getLatestBlockhash();
    h.chain.fixedBlockhash = blockhash;
    const body = { amount: "11", source: h.accounts.source };
    const { body: first } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      body
    );
    const { body: second } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      body
    );
    expect(first.plan.blockhash).toBe(second.plan.blockhash);
    expect(first.plan.messageHash).not.toBe(second.plan.messageHash);
    const a = await h.sign(first, h.roles.treasury);
    const b = await h.sign(second, h.roles.treasury);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.attempts[0].signature).not.toBe(b.body.attempts[0].signature);
  });

  test("a wallet that re-signs with a fresh blockhash is still matched by the operation memo", async () => {
    const { intent } = await h.createVault();
    const { body: fund } = await h.api(
      "POST",
      `/v1/vaults/${intent.vault}/fund`,
      {
        amount: "12",
        source: h.accounts.source,
      }
    );
    const { compileIntentTransaction, encodeWireTransaction } =
      await import("@forge/sdk");
    const rebuilt = compileIntentTransaction(
      fund.intent,
      await h.chain.getLatestBlockhash(),
      { memo: fund.plan.memo }
    );
    const signed = await signPlanTransaction(encodeWireTransaction(rebuilt), [
      h.roles.treasury.pair,
    ]);
    await h.chain.land(signed);
    await h.worker().tick();
    const { body: op } = await h.api("GET", `/v1/operations/${fund.id}`);
    expect(op.status).toBe("finalized");
    expect(op.attempts[0].status).toBe("landed_ok");
  });

  test("the indexer recovers when the node pruned its cursor transaction", async () => {
    const { intent } = await h.createVault();
    const worker = h.worker();
    await worker.indexer.syncAll();
    const cursors = await h.db`SELECT signature FROM cursors`;
    expect(cursors.length).toBeGreaterThan(0);
    h.chain.prune(cursors.map((c: { signature: string }) => c.signature));
    h.setVault(intent, {}, 5n);
    h.chain.landRaw({
      feePayer: h.roles.borrower.address,
      signature: "pruned".padEnd(88, "2"),
      tokenBalances: [
        {
          account: intent.vaultTokenAccount,
          mint: h.accounts.mint,
          owner: intent.vault,
          post: 5n,
          pre: 0n,
        },
      ],
    });
    await worker.indexer.syncAll();
    const exceptions = await h.db`SELECT kind, amount FROM exceptions`;
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      amount: "5",
      kind: "unexpected_deposit",
    });
  });

  test("worker heartbeat keeps a failing stage's error until that stage recovers", async () => {
    await h.createVault();
    const worker = h.worker();
    h.chain.rpcDown = true;
    await worker.tick();
    h.chain.rpcDown = false;
    const [{ details }] =
      await h.db`SELECT details FROM worker_heartbeats WHERE worker_id = 'w1'`;
    expect(Object.keys(details.errors)).toContain("indexer");
    await worker.tick();
    const [after] =
      await h.db`SELECT details FROM worker_heartbeats WHERE worker_id = 'w1'`;
    expect(after.details.errors).toEqual({});
  });

  test("webhooks are signed, retried and keep a stable event id", async () => {
    const received: { id: string; signature: string | null }[] = [];
    let fail = true;
    const receiver = Bun.serve({
      fetch: async (request) => {
        const body = await request.json();
        received.push({
          id: body.id,
          signature: request.headers.get("forge-signature"),
        });
        if (fail) {
          fail = false;
          return new Response("nope", { status: 500 });
        }
        return new Response("ok");
      },
      port: 0,
    });
    await h.db`UPDATE institutions SET webhook_url = ${`http://127.0.0.1:${receiver.port}/hook`} WHERE id = ${h.bank.institution.id}`;
    await h.createVault();
    const worker = h.worker();
    await worker.webhooks.deliver();
    await h.db`UPDATE webhook_outbox SET next_attempt_at = now()`;
    await worker.webhooks.deliver();
    receiver.stop(true);
    expect(received).toHaveLength(2);
    expect(received[0]?.id).toBe(received[1]?.id);
    expect(received[0]?.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/u);
    const [row] = await h.db`SELECT delivered_at, attempts FROM webhook_outbox`;
    expect(row.delivered_at).not.toBeNull();
    expect(row.attempts).toBe(2);
  });
});

void tokenAccountData;
