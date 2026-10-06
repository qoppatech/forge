/**
 * End-to-end validation on a disposable loopback validator (issues #1 and #6).
 *
 * Independent demonstration wallets play the treasury, both approvers, the borrower and an
 * outsider. Each signs only its own transactions, locally, after verifying the plan. The API
 * and worker run as separate processes and never receive a private key.
 *
 * Prerequisites: `nix-shell --run 'bash scripts/localnet.sh up'` and a built SDK.
 */
import path from "node:path";

import {
  compileIntentTransaction,
  decodeLoanAccount,
  decodeTransactionError,
  decodeVaultAccount,
  encodeWireTransaction,
  formatTokenAmount,
  signPlanTransaction,
  verifyPlan,
} from "@forge/sdk";
import type { ForgeIntent } from "@forge/sdk";
import {
  getTransferCheckedInstruction,
  getTransferInstruction,
} from "@solana-program/token";
import type { Address } from "@solana/kit";
import { SQL } from "bun";
import type { Subprocess } from "bun";

import {
  createRpc,
  mintTo,
  send,
  sleep,
  tokenBalance,
  waitFor,
  waitForSignature,
  walletFromSeed,
} from "./lib";
import type { Wallet } from "./lib";
import { DEMO_DIR, ROOT, seed, writeSession } from "./seed";
import type { Session } from "./seed";

const RPC_URL = process.env.FORGE_RPC_URL ?? "http://127.0.0.1:8899";
const PG = process.env.FORGE_PG ?? "postgres://forge@127.0.0.1:54329";
const DATABASE_URL = `${PG}/forge_e2e`;
const API_URL = "http://127.0.0.1:3102";
const T = (tokens: number) => BigInt(Math.round(tokens * 1_000_000));

const rpc = createRpc(RPC_URL);
const evidence: { step: string; detail: Record<string, unknown> }[] = [];
const processes = new Map<string, Subprocess>();

/** Loosely typed JSON from the API under test; each check asserts the shape it relies on. */
// oxlint-disable-next-line no-explicit-any -- untyped API responses in the e2e harness
type ApiJson = any;

function record(step: string, detail: Record<string, unknown> = {}) {
  // oxlint-disable-next-line sort-keys -- evidence entries keep their established step-first layout
  evidence.push({ step, detail });
  const short = Object.entries(detail)
    .map(
      ([k, v]) =>
        `${k}=${typeof v === "string" && v.length > 20 ? `${v.slice(0, 8)}…` : String(v)}`
    )
    .join(" ");
  console.log(`  ✔ ${step}${short ? `  ${short}` : ""}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Check failed: ${message}`);
  }
}

function startProcess(name: "api" | "worker") {
  processes.set(
    name,
    Bun.spawn(
      [process.execPath, path.join(ROOT, "apps/api/src/main.ts"), name],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          FORGE_API_ADDR: "127.0.0.1:3102",
          FORGE_DATABASE_URL: DATABASE_URL,
          FORGE_NETWORK: "localnet",
          FORGE_RPC_URL: RPC_URL,
          FORGE_WORKER_ID: `e2e-${name}`,
          FORGE_WORKER_TICK_MS: "500",
        },
        stderr: Bun.file(path.join(DEMO_DIR, `${name}.err.log`)),
        stdout: Bun.file(path.join(DEMO_DIR, `${name}.log`)),
      }
    )
  );
}

async function stopProcess(name: "api" | "worker") {
  processes.get(name)?.kill();
  await processes.get(name)?.exited;
  processes.delete(name);
}

function client(apiKey: string) {
  return async (
    method: string,
    route: string,
    body?: unknown
  ): Promise<{ status: number; body: ApiJson }> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
    if (method === "POST") {
      headers["idempotency-key"] = crypto.randomUUID();
    }
    const response = await fetch(`${API_URL}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    });
    return { body: await response.json(), status: response.status };
  };
}

/** Prints the finalized postings of a statement, one ledger line each. */
function printStatement(postings: ApiJson[]) {
  console.log("\nStatement (finalized postings):");
  for (const p of postings) {
    const amount =
      p.debit === "0"
        ? `Cr ${formatTokenAmount(p.credit)}`
        : `Dr ${formatTokenAmount(p.debit)}`;
    console.log(
      `  slot ${p.slot}  ${p.entry.padEnd(20)} ${p.account.padEnd(22)} ${amount.padStart(18)}  ${p.business_ref ?? ""}  ${p.signature.slice(0, 12)}…`
    );
  }
}

async function main() {
  console.log("FORGE end-to-end on a disposable loopback validator\n");
  const health = await fetch(RPC_URL, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "getHealth" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  }).then((r) => r.json());
  check(
    health.result === "ok",
    "local validator is healthy (run scripts/localnet.sh up)"
  );
  check(
    RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost"),
    "RPC is loopback only"
  );

  const admin = new SQL(`${PG}/postgres`);
  await admin.unsafe("DROP DATABASE IF EXISTS forge_e2e WITH (FORCE)");
  await admin.unsafe("CREATE DATABASE forge_e2e");
  await admin.close();
  const db = new SQL(DATABASE_URL);

  const webhooks: { id: string; type: string }[] = [];
  const receiver = Bun.serve({
    fetch: async (request) => {
      const body = await request.json();
      webhooks.push({ id: body.id, type: body.type });
      return new Response("ok");
    },
    hostname: "127.0.0.1",
    port: 0,
  });

  startProcess("api");
  await waitFor("API health", async () => {
    const response = await fetch(`${API_URL}/health`).catch(() => null);
    return response?.ok;
  });
  startProcess("worker");
  const session: Session = await seed({
    apiUrl: API_URL,
    databaseUrl: DATABASE_URL,
    rpcUrl: RPC_URL,
    webhookUrl: `http://127.0.0.1:${receiver.port}/forge`,
  });
  await writeSession(session);
  const w: Record<keyof Session["wallets"], Wallet> = {} as never;
  for (const [name, wallet] of Object.entries(session.wallets)) {
    // oxlint-disable-next-line no-await-in-loop -- wallets are derived one at a time in session order
    w[name as keyof Session["wallets"]] = await walletFromSeed(
      name,
      wallet.seed
    );
  }
  const acc = session.accounts as Record<keyof Session["accounts"], Address>;
  const api = client(session.apiKey);
  const otherApi = client(session.otherApiKey);
  // oxlint-disable-next-line sort-keys -- detail keys print in this order
  record("fixtures seeded", {
    mint: acc.mint,
    treasury: w.treasury.address,
    borrower: w.borrower.address,
  });

  function waitOp(id: string, statuses: string[], timeoutMs = 120_000) {
    return waitFor(
      `operation ${id} → ${statuses.join("|")}`,
      async () => {
        const { body: op } = await api("GET", `/v1/operations/${id}`);
        return statuses.includes(op.status) ? op : undefined;
      },
      { timeoutMs }
    );
  }

  /** Each signer verifies the plan bytes against the intent, then signs locally. */
  async function signOp(op: ApiJson, signers: Wallet[]) {
    const problems = await verifyPlan(op.plan);
    check(problems.length === 0, `plan verifies: ${problems.join("; ")}`);
    let latest = op;
    for (const signer of signers) {
      // oxlint-disable-next-line no-await-in-loop -- signers sign in order, one submission at a time
      const signed = await signPlanTransaction(op.plan.transaction, [
        signer.keyPair,
      ]);
      // oxlint-disable-next-line no-await-in-loop -- each signature is accepted before the next signer
      const response = await api("POST", `/v1/operations/${op.id}/signatures`, {
        transaction: signed,
      });
      check(
        response.status === 200,
        `signature accepted: ${JSON.stringify(response.body)}`
      );
      latest = response.body;
    }
    return latest;
  }

  async function run(
    route: string,
    body: unknown,
    signers: Wallet[],
    expected = ["finalized"]
  ) {
    const created = await api("POST", route, body);
    check(
      created.status === 201,
      `${route} planned: ${JSON.stringify(created.body)}`
    );
    await signOp(created.body, signers);
    return waitOp(created.body.id, expected);
  }

  /** A transaction built with the SDK and sent straight to the validator, bypassing the API. */
  async function direct(intent: ForgeIntent, signers: Wallet[]) {
    const { value } = await rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    const tx = compileIntentTransaction(intent, value);
    const signed = await signPlanTransaction(
      encodeWireTransaction(tx),
      signers.map((s) => s.keyPair)
    );
    const signature = await rpc
      .sendTransaction(signed as never, {
        encoding: "base64",
        skipPreflight: true,
      })
      .send();
    const { err } = await waitForSignature(rpc, signature);
    return {
      error: err ? decodeTransactionError(err, [intent.kind]) : null,
      signature,
    };
  }

  async function vaultState(vault: Address) {
    const { value } = await rpc
      .getAccountInfo(vault, { commitment: "confirmed", encoding: "base64" })
      .send();
    if (!value) {
      throw new Error(`vault account ${vault} not found`);
    }
    return decodeVaultAccount(
      Uint8Array.from(atob(value.data[0]), (c) => c.codePointAt(0) ?? 0)
    );
  }

  async function vaultPaused(vault: Address) {
    const { disbursementPaused } = await vaultState(vault);
    return disbursementPaused;
  }

  async function vaultPauseSeq(vault: Address) {
    const { pauseSeq } = await vaultState(vault);
    return pauseSeq;
  }

  async function loanState(loan: Address) {
    const { value } = await rpc
      .getAccountInfo(loan, { commitment: "confirmed", encoding: "base64" })
      .send();
    if (!value) {
      throw new Error(`loan account ${loan} not found`);
    }
    return decodeLoanAccount(
      Uint8Array.from(atob(value.data[0]), (c) => c.codePointAt(0) ?? 0)
    );
  }

  // ── Issue #1: vault on a real validator; unauthorized direct withdrawal fails ──────────────
  const createOp = await run(
    "/v1/vaults",
    {
      approvers: [w.approverA.address, w.approverB.address],
      mint: acc.mint,
      outstandingLimit: T(10_000).toString(),
      perLoanLimit: T(5000).toString(),
      reference: "main",
      treasury: w.treasury.address,
      treasuryDestination: acc.treasuryDestination,
    },
    [w.treasury]
  );
  const vault = createOp.intent.vault as Address;
  const vaultTokens = createOp.intent.vaultTokenAccount as Address;
  const config = await vaultState(vault);
  check(
    config.approvers.join(",") ===
      [w.approverA.address, w.approverB.address].join(","),
    "immutable approvers stored"
  );
  // oxlint-disable-next-line sort-keys -- detail keys print in this order
  record("#1 vault created on local validator", {
    vault,
    signature: createOp.appliedSignature,
    slot: createOp.finalizedSlot,
  });

  const fundOp = await run(
    `/v1/vaults/${vault}/fund`,
    { amount: T(10_000).toString(), source: acc.treasurySource },
    [w.treasury]
  );
  check(
    (await tokenBalance(rpc, vaultTokens)) === T(10_000),
    "vault holds 10,000"
  );
  record("#1 vault funded 10,000 FORGE_TEST_USD", {
    signature: fundOp.appliedSignature,
    vaultCash: "10000000000",
  });

  /** A direct SPL transfer out of the vault token account, bypassing the program. */
  async function attemptDirectWithdrawal(thief: Wallet) {
    const before = await tokenBalance(rpc, vaultTokens);
    const { err } = await send(
      rpc,
      thief.signer,
      [
        getTransferInstruction({
          amount: 1n,
          authority: thief.signer,
          destination: acc.outsiderTokens,
          source: vaultTokens,
        }),
      ],
      { expectFailure: true }
    );
    check(
      err !== null && (await tokenBalance(rpc, vaultTokens)) === before,
      "direct SPL withdrawal fails without side effects"
    );
    record(`#1 unauthorized direct SPL withdrawal by ${thief.name} rejected`, {
      error: decodeTransactionError(err).name,
    });
  }
  for (const thief of [w.outsider, w.treasury]) {
    // oxlint-disable-next-line no-await-in-loop -- attempts run in order; each must finalize first
    await attemptDirectWithdrawal(thief);
  }

  // ── Issue #6: lending flow through the service ────────────────────────────────────────────
  const offerExpiry = String(Math.floor(Date.now() / 1000) + 3600);
  const proposeOp = await run(
    `/v1/vaults/${vault}/loans`,
    {
      approver: w.approverA.address,
      borrower: w.borrower.address,
      destination: acc.borrowerTokens,
      offerExpiry,
      principal: T(5000).toString(),
      reference: "LN-2026-001",
      termRateBps: 200,
      termSeconds: String(30 * 24 * 3600),
    },
    [w.approverA]
  );
  const loan = proposeOp.intent.loan as Address;
  check(
    proposeOp.display.payoff === T(5100).toString(),
    "fixed payoff 5,100 shown for review"
  );
  record("loan proposed (5,000 at 2% whole-term)", {
    loan,
    signature: proposeOp.appliedSignature,
  });

  // Two operators approve as approver A at the same time: one applies, the replay resolves.
  const { body: approveA1 } = await api("POST", `/v1/loans/${loan}/approve`, {
    approver: w.approverA.address,
  });
  const { body: approveA2 } = await api("POST", `/v1/loans/${loan}/approve`, {
    approver: w.approverA.address,
  });
  await signOp(approveA1, [w.approverA]);
  await signOp(approveA2, [w.approverA]);
  const [a1, a2] = [
    await waitOp(approveA1.id, ["finalized", "already_applied"]),
    await waitOp(approveA2.id, ["finalized", "already_applied"]),
  ];
  check(
    [a1.status, a2.status].toSorted().join(",") === "already_applied,finalized",
    "duplicate approval resolves to already_applied"
  );
  record(
    "approver A approved; concurrent duplicate resolved as already_applied",
    {
      applied:
        a1.status === "finalized" ? a1.appliedSignature : a2.appliedSignature,
      replayError: (a1.status === "already_applied" ? a1 : a2).error.name,
    }
  );

  const premature = await api("POST", `/v1/loans/${loan}/draw`, {});
  check(premature.status === 409, "API refuses to plan a premature draw");
  const drawIntent: ForgeIntent = {
    borrower: w.borrower.address,
    destination: acc.borrowerTokens,
    kind: "draw_loan",
    loan,
    mint: acc.mint,
    vault,
    vaultTokenAccount: vaultTokens,
  };
  const beforePremature = await tokenBalance(rpc, vaultTokens);
  const prematureDirect = await direct(drawIntent, [w.borrower]);
  check(
    prematureDirect.error?.name === "InvalidLoanState" &&
      (await tokenBalance(rpc, vaultTokens)) === beforePremature,
    "premature direct draw rejected by the program"
  );
  record("premature draw rejected (API 409; direct program call 6010)", {
    signature: prematureDirect.signature,
  });

  await run(`/v1/loans/${loan}/approve`, { approver: w.approverB.address }, [
    w.approverB,
  ]);
  const approvedLoan = await loanState(loan);
  check(approvedLoan.state === "Approved", "loan approved by both approvers");
  record("approver B approved → Approved");

  const wrongSigner = await direct(
    { ...drawIntent, borrower: w.outsider.address },
    [w.outsider]
  );
  check(wrongSigner.error?.name === "InvalidBorrower", "outsider cannot draw");
  const wrongAccount = await direct(
    { ...drawIntent, destination: acc.outsiderTokens },
    [w.borrower]
  );
  check(
    wrongAccount.error?.name === "InvalidDestination",
    `draw to another destination is rejected (got ${wrongAccount.error?.name})`
  );
  check(
    (await tokenBalance(rpc, vaultTokens)) === T(10_000),
    "rejections left vault cash unchanged"
  );
  record(
    "wrong signer (6016) and wrong destination (6017) rejected without side effects"
  );

  const drawOp = await run(`/v1/loans/${loan}/draw`, {}, [w.borrower]);
  check(
    (await tokenBalance(rpc, vaultTokens)) === T(5000),
    "vault cash 5,000 after draw"
  );
  check(
    (await tokenBalance(rpc, acc.borrowerTokens)) === T(5100),
    "borrower holds 5,100"
  );
  const { outstandingPrincipal: drawnPrincipal } = await vaultState(vault);
  check(drawnPrincipal === T(5000), "receivable 5,000");
  // oxlint-disable-next-line sort-keys -- detail keys print in this order
  record("borrower drew 5,000", {
    signature: drawOp.appliedSignature,
    vaultCash: "5000000000",
    receivable: "5000000000",
  });

  const { status: secondDrawStatus } = await api(
    "POST",
    `/v1/loans/${loan}/draw`,
    {}
  );
  check(secondDrawStatus === 409, "API refuses a second draw");
  const secondDraw = await direct(drawIntent, [w.borrower]);
  check(
    secondDraw.error?.name === "InvalidLoanState" &&
      (await tokenBalance(rpc, vaultTokens)) === T(5000),
    "second draw rejected"
  );
  record("repeated draw rejected (API 409; program 6010)");

  const repayOp = await run(`/v1/loans/${loan}/repay`, {}, [w.borrower]);
  check(
    (await tokenBalance(rpc, vaultTokens)) === T(10_100),
    "vault cash 10,100 after repayment"
  );
  const { outstandingPrincipal: repaidPrincipal } = await vaultState(vault);
  check(repaidPrincipal === 0n, "receivable back to 0");
  // oxlint-disable-next-line sort-keys -- detail keys print in this order
  record("borrower repaid 5,100", {
    signature: repayOp.appliedSignature,
    vaultCash: "10100000000",
    receivable: "0",
  });

  const secondRepay = await direct(
    {
      borrower: w.borrower.address,
      borrowerTokens: acc.borrowerTokens,
      kind: "repay_loan",
      loan,
      mint: acc.mint,
      vault,
      vaultTokenAccount: vaultTokens,
    },
    [w.borrower]
  );
  check(
    secondRepay.error?.name === "InvalidLoanState",
    "second repayment rejected"
  );
  record("repeated repayment rejected (6010)");

  const { status: otherReadStatus } = await otherApi(
    "GET",
    `/v1/vaults/${vault}`
  );
  check(otherReadStatus === 404, "other institution cannot read");
  const { status: otherWriteStatus } = await otherApi(
    "POST",
    `/v1/vaults/${vault}/fund`,
    { amount: "1", source: acc.treasurySource }
  );
  check(otherWriteStatus === 404, "other institution cannot mutate");
  record("cross-institution read and write rejected (404)");

  // ── Withdrawal proposals and pause ordering (ADR 0003) ────────────────────────────────────
  const proposeW = await run(
    `/v1/vaults/${vault}/withdrawals`,
    {
      amount: T(100).toString(),
      approver: w.approverA.address,
      reference: "WD-1",
    },
    [w.approverA]
  );
  await run(
    `/v1/withdrawals/${proposeW.intent.withdrawal}/approve`,
    { approver: w.approverB.address },
    [w.approverB]
  );
  check(
    (await tokenBalance(rpc, vaultTokens)) === T(10_000),
    "vault cash 10,000 after withdrawal"
  );
  check(
    (await tokenBalance(rpc, acc.treasuryDestination)) === T(100),
    "treasury destination received 100"
  );
  record("withdrawal of 100 proposed by A, executed on B's approval");

  const { body: pause } = await api("POST", `/v1/vaults/${vault}/pause`, {
    paused: true,
  });
  const { body: staleUnpause } = await api(
    "POST",
    `/v1/vaults/${vault}/pause`,
    { paused: false }
  );
  check(
    pause.intent.expectedSeq === "0" && staleUnpause.intent.expectedSeq === "0",
    "both planned at pause_seq 0"
  );
  await signOp(pause, [w.approverA, w.approverB]);
  await waitOp(pause.id, ["finalized"]);
  await signOp(staleUnpause, [w.approverA, w.approverB]);
  const stale = await waitOp(staleUnpause.id, ["failed"]);
  check(
    stale.error.name === "StalePauseSequence" && (await vaultPaused(vault)),
    "stale unpause cannot undo the newer pause"
  );
  await run(`/v1/vaults/${vault}/pause`, { paused: false }, [
    w.approverA,
    w.approverB,
  ]);
  check(
    !(await vaultPaused(vault)) && (await vaultPauseSeq(vault)) === 2n,
    "unpaused at seq 2"
  );
  record("pause ordering: stale unpause failed (6019); fresh unpause applied", {
    pauseSeq: "2",
  });

  // ── Reconciliation edge cases ─────────────────────────────────────────────────────────────
  await mintTo(rpc, w.treasury.signer, acc.mint, acc.outsiderTokens, T(1));
  await mintTo(rpc, w.treasury.signer, acc.mint, acc.treasurySource, T(5));
  record("disclosed fixture mint: 1 token to outsider, 5 to treasury source");
  const donation = await send(rpc, w.outsider.signer, [
    getTransferCheckedInstruction({
      amount: T(1),
      authority: w.outsider.signer,
      decimals: 6,
      destination: vaultTokens,
      mint: acc.mint,
      source: acc.outsiderTokens,
    }),
  ]);
  const exception = await waitFor("donation exception", async () => {
    const { body: statement } = await api(
      "GET",
      `/v1/vaults/${vault}/statement`
    );
    return statement.exceptions.find(
      (e: { signature: string }) => e.signature === donation.signature
    );
  });
  check(
    exception.kind === "unexpected_deposit" &&
      exception.amount === T(1).toString(),
    "donation flagged, not applied to the loan"
  );
  record("direct token donation → unexpected_deposit exception", {
    signature: donation.signature,
  });

  // A wallet signs and broadcasts the plan itself; the API never sees the signed bytes.
  const { body: selfBroadcast } = await api(
    "POST",
    `/v1/vaults/${vault}/fund`,
    { amount: T(2).toString(), source: acc.treasurySource }
  );
  const selfSigned = await signPlanTransaction(selfBroadcast.plan.transaction, [
    w.treasury.keyPair,
  ]);
  await rpc.sendTransaction(selfSigned as never, { encoding: "base64" }).send();
  const matched = await waitOp(selfBroadcast.id, ["finalized"]);
  record("wallet self-broadcast matched by message hash and finalized", {
    signature: matched.appliedSignature,
  });

  // Worker down while a submitted transaction lands; it catches up after restart.
  await stopProcess("worker");
  const { body: whileDown } = await api("POST", `/v1/vaults/${vault}/fund`, {
    amount: T(1).toString(),
    source: acc.treasurySource,
  });
  const submitted = await signOp(whileDown, [w.treasury]);
  check(submitted.status === "submitted", "submitted while worker down");
  await waitForSignature(rpc, submitted.attempts[0].signature, "finalized");
  const { body: stalled } = await api("GET", `/v1/operations/${whileDown.id}`);
  check(stalled.status === "submitted", "no progress without the worker");
  startProcess("worker");
  await waitOp(whileDown.id, ["finalized"]);
  record(
    "worker restart finalized a transaction that landed while it was down",
    { signature: submitted.attempts[0].signature }
  );

  // Plans nobody signs expire only after proof; a new attempt gets a new blockhash.
  const { body: unsigned } = await api("POST", `/v1/vaults/${vault}/fund`, {
    amount: T(1).toString(),
    source: acc.treasurySource,
  });
  console.log(
    `    … waiting for blockhash expiry (last valid block height ${unsigned.plan.lastValidBlockHeight})`
  );
  const expired = await waitOp(unsigned.id, ["expired"], 240_000);
  const reprepared = await api("POST", `/v1/operations/${unsigned.id}/prepare`);
  check(
    reprepared.status === 201 && reprepared.body.plan.attemptNo === 2,
    "new attempt after proven expiry"
  );
  await signOp(reprepared.body, [w.treasury]);
  const retried = await waitOp(unsigned.id, ["finalized"]);
  record("unsigned plan expired with proof; attempt 2 signed and finalized", {
    firstBlockhash: expired.attempts[0].blockhash,
    secondBlockhash: retried.attempts[1].blockhash,
  });

  // Full replay: drop cursors and reprocess history; nothing is posted twice.
  const counts = async () => {
    const [row] =
      await db`SELECT (SELECT count(*) FROM postings)::int AS postings, (SELECT count(*) FROM chain_events)::int AS events,
                     (SELECT count(*) FROM webhook_outbox)::int AS outbox, (SELECT count(*) FROM exceptions)::int AS exceptions`;
    return row;
  };
  const before = await counts();
  await stopProcess("worker");
  await db`DELETE FROM cursors`;
  startProcess("worker");
  await waitFor("indexer replay", async () => {
    const [cursors] = await db`SELECT count(*)::int AS n FROM cursors`;
    return cursors.n >= 2;
  });
  await sleep(3000);
  const after = await counts();
  check(
    JSON.stringify(before) === JSON.stringify(after),
    `replay is idempotent ${JSON.stringify(before)} vs ${JSON.stringify(after)}`
  );
  record(
    "reconciler replay from empty cursors created no duplicate postings/events/webhooks",
    after
  );

  // ── Statement ─────────────────────────────────────────────────────────────────────────────
  const statement = await waitFor("reconciled statement", async () => {
    const { body: s } = await api("GET", `/v1/vaults/${vault}/statement`);
    return s.reconciliation.matches ? s : undefined;
  });
  check(statement.balanced, "postings balance");
  check(
    statement.postings.every(
      (p: { signature: string; slot: string }) => p.signature && p.slot
    ),
    "every posting links to a signature and slot"
  );
  const cash = await tokenBalance(rpc, vaultTokens, "finalized");
  check(
    statement.reconciliation.ledgerCash === cash.toString(),
    "ledger cash equals finalized chain cash"
  );
  const balances = Object.fromEntries(
    statement.balances.map((b: { account: string; balance: string }) => [
      b.account,
      formatTokenAmount(b.balance),
    ])
  );
  record("statement balanced and reconciled to chain cash", {
    ledgerCash: formatTokenAmount(statement.reconciliation.ledgerCash),
    ...balances,
  });

  await waitFor("webhook delivery", async () => {
    const [pending] =
      await db`SELECT count(*)::int AS n FROM webhook_outbox WHERE delivered_at IS NULL`;
    return pending.n === 0;
  });
  const uniqueIds = new Set(webhooks.map((e) => e.id));
  // oxlint-disable-next-line sort-keys -- detail keys print in this order
  record("webhooks delivered at least once with stable event ids", {
    deliveries: webhooks.length,
    uniqueEvents: uniqueIds.size,
    outbox: after.outbox,
  });

  printStatement(statement.postings);
  await db.close();
  receiver.stop(true);
}

const evidencePath = path.join(DEMO_DIR, "e2e-evidence.json");
try {
  await main();
  await Bun.write(
    evidencePath,
    // oxlint-disable-next-line sort-keys -- the evidence file leads with its result
    JSON.stringify({ result: "passed", evidence }, null, 2)
  );
  console.log(
    `\nE2E passed: ${evidence.length} checks. Evidence: ${evidencePath}`
  );
} catch (error) {
  await Bun.write(
    evidencePath,
    JSON.stringify(
      // oxlint-disable-next-line sort-keys -- the evidence file leads with its result
      { result: "failed", error: String(error), evidence },
      null,
      2
    )
  );
  console.error(
    `\nE2E FAILED: ${(error as Error).message}\nLogs: ${DEMO_DIR}/{api,worker}*.log`
  );
  process.exitCode = 1;
} finally {
  await stopProcess("worker").catch(() => null);
  await stopProcess("api").catch(() => null);
}
