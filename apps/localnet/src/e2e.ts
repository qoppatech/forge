/**
 * End-to-end validation on a disposable loopback validator (issues #1 and #6).
 *
 * Independent demonstration wallets play the treasury, both approvers, the borrower and an
 * outsider. Each signs only its own transactions, locally, after verifying the plan. The API
 * and worker run as separate processes and never receive a private key.
 *
 * Prerequisites: `nix-shell --run 'bash scripts/localnet.sh up'` and a built SDK.
 */
import { join } from "node:path";
import { SQL, type Subprocess } from "bun";
import { getTransferCheckedInstruction, getTransferInstruction } from "@solana-program/token";
import {
  compileIntentTransaction,
  decodeLoanAccount,
  decodeTransactionError,
  decodeVaultAccount,
  encodeWireTransaction,
  formatTokenAmount,
  signPlanTransaction,
  verifyPlan,
  type ForgeIntent,
} from "@forge/sdk";
import type { Address } from "@solana/kit";

import { createRpc, mintTo, send, sleep, tokenBalance, waitFor, waitForSignature, walletFromSeed, type Wallet } from "./lib";
import { DEMO_DIR, ROOT, seed, writeSession, type Session } from "./seed";

const RPC_URL = process.env.FORGE_RPC_URL ?? "http://127.0.0.1:8899";
const PG = process.env.FORGE_PG ?? "postgres://forge@127.0.0.1:54329";
const DATABASE_URL = `${PG}/forge_e2e`;
const API_URL = "http://127.0.0.1:3102";
const T = (tokens: number) => BigInt(Math.round(tokens * 1_000_000));

const rpc = createRpc(RPC_URL);
const evidence: { step: string; detail: Record<string, unknown> }[] = [];
const processes: Record<string, Subprocess> = {};

function record(step: string, detail: Record<string, unknown> = {}) {
  evidence.push({ step, detail });
  const short = Object.entries(detail)
    .map(([k, v]) => `${k}=${typeof v === "string" && v.length > 20 ? `${v.slice(0, 8)}…` : String(v)}`)
    .join(" ");
  console.log(`  ✔ ${step}${short ? `  ${short}` : ""}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

function startProcess(name: "api" | "worker") {
  processes[name] = Bun.spawn([process.execPath, join(ROOT, "apps/api/src/main.ts"), name], {
    cwd: ROOT,
    env: {
      ...process.env,
      FORGE_DATABASE_URL: DATABASE_URL,
      FORGE_RPC_URL: RPC_URL,
      FORGE_NETWORK: "localnet",
      FORGE_API_ADDR: "127.0.0.1:3102",
      FORGE_WORKER_TICK_MS: "500",
      FORGE_WORKER_ID: `e2e-${name}`,
    },
    stdout: Bun.file(join(DEMO_DIR, `${name}.log`)),
    stderr: Bun.file(join(DEMO_DIR, `${name}.err.log`)),
  });
}

async function stopProcess(name: "api" | "worker") {
  processes[name]?.kill();
  await processes[name]?.exited;
  delete processes[name];
}

function client(apiKey: string) {
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    if (method === "POST") headers["idempotency-key"] = crypto.randomUUID();
    const response = await fetch(`${API_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
}

async function main() {
  console.log("FORGE end-to-end on a disposable loopback validator\n");
  const health = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
  }).then((r) => r.json());
  check(health.result === "ok", "local validator is healthy (run scripts/localnet.sh up)");
  check(RPC_URL.includes("127.0.0.1") || RPC_URL.includes("localhost"), "RPC is loopback only");

  const admin = new SQL(`${PG}/postgres`);
  await admin.unsafe("DROP DATABASE IF EXISTS forge_e2e WITH (FORCE)");
  await admin.unsafe("CREATE DATABASE forge_e2e");
  await admin.close();
  const db = new SQL(DATABASE_URL);

  const webhooks: { id: string; type: string }[] = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      webhooks.push({ id: body.id, type: body.type });
      return new Response("ok");
    },
  });

  startProcess("api");
  await waitFor("API health", async () => (await fetch(`${API_URL}/health`).catch(() => null))?.ok);
  startProcess("worker");
  const session: Session = await seed({
    rpcUrl: RPC_URL,
    apiUrl: API_URL,
    databaseUrl: DATABASE_URL,
    webhookUrl: `http://127.0.0.1:${receiver.port}/forge`,
  });
  await writeSession(session);
  const w: Record<keyof Session["wallets"], Wallet> = {} as never;
  for (const [name, wallet] of Object.entries(session.wallets)) {
    w[name as keyof Session["wallets"]] = await walletFromSeed(name, wallet.seed);
  }
  const acc = session.accounts as Record<keyof Session["accounts"], Address>;
  const api = client(session.apiKey);
  const otherApi = client(session.otherApiKey);
  record("fixtures seeded", { mint: acc.mint, treasury: w.treasury.address, borrower: w.borrower.address });

  async function waitOp(id: string, statuses: string[], timeoutMs = 120_000) {
    return waitFor(
      `operation ${id} → ${statuses.join("|")}`,
      async () => {
        const op = (await api("GET", `/v1/operations/${id}`)).body;
        return statuses.includes(op.status) ? op : undefined;
      },
      { timeoutMs },
    );
  }

  /** Each signer verifies the plan bytes against the intent, then signs locally. */
  async function signOp(op: any, signers: Wallet[]) {
    const problems = await verifyPlan(op.plan);
    check(problems.length === 0, `plan verifies: ${problems.join("; ")}`);
    let latest = op;
    for (const signer of signers) {
      const signed = await signPlanTransaction(op.plan.transaction, [signer.keyPair]);
      const response = await api("POST", `/v1/operations/${op.id}/signatures`, { transaction: signed });
      check(response.status === 200, `signature accepted: ${JSON.stringify(response.body)}`);
      latest = response.body;
    }
    return latest;
  }

  async function run(path: string, body: unknown, signers: Wallet[], expected = ["finalized"]) {
    const created = await api("POST", path, body);
    check(created.status === 201, `${path} planned: ${JSON.stringify(created.body)}`);
    await signOp(created.body, signers);
    return waitOp(created.body.id, expected);
  }

  /** A transaction built with the SDK and sent straight to the validator, bypassing the API. */
  async function direct(intent: ForgeIntent, signers: Wallet[]) {
    const { value } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const tx = compileIntentTransaction(intent, value);
    const signed = await signPlanTransaction(encodeWireTransaction(tx), signers.map((s) => s.keyPair));
    const signature = await rpc.sendTransaction(signed as never, { encoding: "base64", skipPreflight: true }).send();
    const { err } = await waitForSignature(rpc, signature);
    return { signature, error: err ? decodeTransactionError(err, [intent.kind]) : null };
  }

  async function vaultState(vault: Address) {
    const { value } = await rpc.getAccountInfo(vault, { encoding: "base64", commitment: "confirmed" }).send();
    return decodeVaultAccount(Uint8Array.from(atob(value!.data[0]), (c) => c.charCodeAt(0)));
  }

  async function loanState(loan: Address) {
    const { value } = await rpc.getAccountInfo(loan, { encoding: "base64", commitment: "confirmed" }).send();
    return decodeLoanAccount(Uint8Array.from(atob(value!.data[0]), (c) => c.charCodeAt(0)));
  }

  // ── Issue #1: vault on a real validator; unauthorized direct withdrawal fails ──────────────
  const createOp = await run(
    "/v1/vaults",
    {
      reference: "main",
      treasury: w.treasury.address,
      mint: acc.mint,
      treasuryDestination: acc.treasuryDestination,
      approvers: [w.approverA.address, w.approverB.address],
      perLoanLimit: T(5_000).toString(),
      outstandingLimit: T(10_000).toString(),
    },
    [w.treasury],
  );
  const vault = createOp.intent.vault as Address;
  const vaultTokens = createOp.intent.vaultTokenAccount as Address;
  const config = await vaultState(vault);
  check(config.approvers.join() === [w.approverA.address, w.approverB.address].join(), "immutable approvers stored");
  record("#1 vault created on local validator", { vault, signature: createOp.appliedSignature, slot: createOp.finalizedSlot });

  const fundOp = await run(`/v1/vaults/${vault}/fund`, { amount: T(10_000).toString(), source: acc.treasurySource }, [w.treasury]);
  check((await tokenBalance(rpc, vaultTokens)) === T(10_000), "vault holds 10,000");
  record("#1 vault funded 10,000 FORGE_TEST_USD", { signature: fundOp.appliedSignature, vaultCash: "10000000000" });

  for (const thief of [w.outsider, w.treasury]) {
    const before = await tokenBalance(rpc, vaultTokens);
    const { err } = await send(rpc, thief.signer, [
      getTransferInstruction({ source: vaultTokens, destination: acc.outsiderTokens, authority: thief.signer, amount: 1n }),
    ], { expectFailure: true });
    check(err !== null && (await tokenBalance(rpc, vaultTokens)) === before, "direct SPL withdrawal fails without side effects");
    record(`#1 unauthorized direct SPL withdrawal by ${thief.name} rejected`, { error: decodeTransactionError(err).name });
  }

  // ── Issue #6: lending flow through the service ────────────────────────────────────────────
  const offerExpiry = String(Math.floor(Date.now() / 1000) + 3600);
  const proposeOp = await run(
    `/v1/vaults/${vault}/loans`,
    {
      reference: "LN-2026-001",
      approver: w.approverA.address,
      borrower: w.borrower.address,
      destination: acc.borrowerTokens,
      principal: T(5_000).toString(),
      termRateBps: 200,
      termSeconds: String(30 * 24 * 3600),
      offerExpiry,
    },
    [w.approverA],
  );
  const loan = proposeOp.intent.loan as Address;
  check(proposeOp.display.payoff === T(5_100).toString(), "fixed payoff 5,100 shown for review");
  record("loan proposed (5,000 at 2% whole-term)", { loan, signature: proposeOp.appliedSignature });

  // Two operators approve as approver A at the same time: one applies, the replay resolves.
  const approveA1 = (await api("POST", `/v1/loans/${loan}/approve`, { approver: w.approverA.address })).body;
  const approveA2 = (await api("POST", `/v1/loans/${loan}/approve`, { approver: w.approverA.address })).body;
  await signOp(approveA1, [w.approverA]);
  await signOp(approveA2, [w.approverA]);
  const [a1, a2] = [await waitOp(approveA1.id, ["finalized", "already_applied"]), await waitOp(approveA2.id, ["finalized", "already_applied"])];
  check([a1.status, a2.status].sort().join() === "already_applied,finalized", "duplicate approval resolves to already_applied");
  record("approver A approved; concurrent duplicate resolved as already_applied", {
    applied: a1.status === "finalized" ? a1.appliedSignature : a2.appliedSignature,
    replayError: (a1.status === "already_applied" ? a1 : a2).error.name,
  });

  const premature = await api("POST", `/v1/loans/${loan}/draw`, {});
  check(premature.status === 409, "API refuses to plan a premature draw");
  const drawIntent: ForgeIntent = {
    kind: "draw_loan",
    borrower: w.borrower.address,
    vault,
    loan,
    mint: acc.mint,
    vaultTokenAccount: vaultTokens,
    destination: acc.borrowerTokens,
  };
  const beforePremature = await tokenBalance(rpc, vaultTokens);
  const prematureDirect = await direct(drawIntent, [w.borrower]);
  check(prematureDirect.error?.name === "InvalidLoanState" && (await tokenBalance(rpc, vaultTokens)) === beforePremature, "premature direct draw rejected by the program");
  record("premature draw rejected (API 409; direct program call 6010)", { signature: prematureDirect.signature });

  await run(`/v1/loans/${loan}/approve`, { approver: w.approverB.address }, [w.approverB]);
  check((await loanState(loan)).state === "Approved", "loan approved by both approvers");
  record("approver B approved → Approved");

  const wrongSigner = await direct({ ...drawIntent, borrower: w.outsider.address }, [w.outsider]);
  check(wrongSigner.error?.name === "InvalidBorrower", "outsider cannot draw");
  const wrongAccount = await direct({ ...drawIntent, destination: acc.outsiderTokens }, [w.borrower]);
  check(wrongAccount.error?.name === "InvalidDestination", `draw to another destination is rejected (got ${wrongAccount.error?.name})`);
  check((await tokenBalance(rpc, vaultTokens)) === T(10_000), "rejections left vault cash unchanged");
  record("wrong signer (6016) and wrong destination (6017) rejected without side effects");

  const drawOp = await run(`/v1/loans/${loan}/draw`, {}, [w.borrower]);
  check((await tokenBalance(rpc, vaultTokens)) === T(5_000), "vault cash 5,000 after draw");
  check((await tokenBalance(rpc, acc.borrowerTokens)) === T(5_100), "borrower holds 5,100");
  check((await vaultState(vault)).outstandingPrincipal === T(5_000), "receivable 5,000");
  record("borrower drew 5,000", { signature: drawOp.appliedSignature, vaultCash: "5000000000", receivable: "5000000000" });

  check((await api("POST", `/v1/loans/${loan}/draw`, {})).status === 409, "API refuses a second draw");
  const secondDraw = await direct(drawIntent, [w.borrower]);
  check(secondDraw.error?.name === "InvalidLoanState" && (await tokenBalance(rpc, vaultTokens)) === T(5_000), "second draw rejected");
  record("repeated draw rejected (API 409; program 6010)");

  const repayOp = await run(`/v1/loans/${loan}/repay`, {}, [w.borrower]);
  check((await tokenBalance(rpc, vaultTokens)) === T(10_100), "vault cash 10,100 after repayment");
  check((await vaultState(vault)).outstandingPrincipal === 0n, "receivable back to 0");
  record("borrower repaid 5,100", { signature: repayOp.appliedSignature, vaultCash: "10100000000", receivable: "0" });

  const secondRepay = await direct(
    { kind: "repay_loan", borrower: w.borrower.address, vault, loan, mint: acc.mint, borrowerTokens: acc.borrowerTokens, vaultTokenAccount: vaultTokens },
    [w.borrower],
  );
  check(secondRepay.error?.name === "InvalidLoanState", "second repayment rejected");
  record("repeated repayment rejected (6010)");

  check((await otherApi("GET", `/v1/vaults/${vault}`)).status === 404, "other institution cannot read");
  check((await otherApi("POST", `/v1/vaults/${vault}/fund`, { amount: "1", source: acc.treasurySource })).status === 404, "other institution cannot mutate");
  record("cross-institution read and write rejected (404)");

  // ── Withdrawal proposals and pause ordering (ADR 0003) ────────────────────────────────────
  const proposeW = await run(`/v1/vaults/${vault}/withdrawals`, { reference: "WD-1", approver: w.approverA.address, amount: T(100).toString() }, [w.approverA]);
  await run(`/v1/withdrawals/${proposeW.intent.withdrawal}/approve`, { approver: w.approverB.address }, [w.approverB]);
  check((await tokenBalance(rpc, vaultTokens)) === T(10_000), "vault cash 10,000 after withdrawal");
  check((await tokenBalance(rpc, acc.treasuryDestination)) === T(100), "treasury destination received 100");
  record("withdrawal of 100 proposed by A, executed on B's approval");

  const pause = (await api("POST", `/v1/vaults/${vault}/pause`, { paused: true })).body;
  const staleUnpause = (await api("POST", `/v1/vaults/${vault}/pause`, { paused: false })).body;
  check(pause.intent.expectedSeq === "0" && staleUnpause.intent.expectedSeq === "0", "both planned at pause_seq 0");
  await signOp(pause, [w.approverA, w.approverB]);
  await waitOp(pause.id, ["finalized"]);
  await signOp(staleUnpause, [w.approverA, w.approverB]);
  const stale = await waitOp(staleUnpause.id, ["failed"]);
  check(stale.error.name === "StalePauseSequence" && (await vaultState(vault)).disbursementPaused, "stale unpause cannot undo the newer pause");
  await run(`/v1/vaults/${vault}/pause`, { paused: false }, [w.approverA, w.approverB]);
  check(!(await vaultState(vault)).disbursementPaused && (await vaultState(vault)).pauseSeq === 2n, "unpaused at seq 2");
  record("pause ordering: stale unpause failed (6019); fresh unpause applied", { pauseSeq: "2" });

  // ── Reconciliation edge cases ─────────────────────────────────────────────────────────────
  await mintTo(rpc, w.treasury.signer, acc.mint, acc.outsiderTokens, T(1));
  await mintTo(rpc, w.treasury.signer, acc.mint, acc.treasurySource, T(5));
  record("disclosed fixture mint: 1 token to outsider, 5 to treasury source");
  const donation = await send(rpc, w.outsider.signer, [
    getTransferCheckedInstruction({ source: acc.outsiderTokens, mint: acc.mint, destination: vaultTokens, authority: w.outsider.signer, amount: T(1), decimals: 6 }),
  ]);
  const exception = await waitFor("donation exception", async () => {
    const statement = (await api("GET", `/v1/vaults/${vault}/statement`)).body;
    return statement.exceptions.find((e: { signature: string }) => e.signature === donation.signature);
  });
  check(exception.kind === "unexpected_deposit" && exception.amount === T(1).toString(), "donation flagged, not applied to the loan");
  record("direct token donation → unexpected_deposit exception", { signature: donation.signature });

  // A wallet signs and broadcasts the plan itself; the API never sees the signed bytes.
  const selfBroadcast = (await api("POST", `/v1/vaults/${vault}/fund`, { amount: T(2).toString(), source: acc.treasurySource })).body;
  const selfSigned = await signPlanTransaction(selfBroadcast.plan.transaction, [w.treasury.keyPair]);
  await rpc.sendTransaction(selfSigned as never, { encoding: "base64" }).send();
  const matched = await waitOp(selfBroadcast.id, ["finalized"]);
  record("wallet self-broadcast matched by message hash and finalized", { signature: matched.appliedSignature });

  // Worker down while a submitted transaction lands; it catches up after restart.
  await stopProcess("worker");
  const whileDown = (await api("POST", `/v1/vaults/${vault}/fund`, { amount: T(1).toString(), source: acc.treasurySource })).body;
  const submitted = await signOp(whileDown, [w.treasury]);
  check(submitted.status === "submitted", "submitted while worker down");
  await waitForSignature(rpc, submitted.attempts[0].signature, "finalized");
  check((await api("GET", `/v1/operations/${whileDown.id}`)).body.status === "submitted", "no progress without the worker");
  startProcess("worker");
  await waitOp(whileDown.id, ["finalized"]);
  record("worker restart finalized a transaction that landed while it was down", { signature: submitted.attempts[0].signature });

  // Plans nobody signs expire only after proof; a new attempt gets a new blockhash.
  const unsigned = (await api("POST", `/v1/vaults/${vault}/fund`, { amount: T(1).toString(), source: acc.treasurySource })).body;
  console.log(`    … waiting for blockhash expiry (last valid block height ${unsigned.plan.lastValidBlockHeight})`);
  const expired = await waitOp(unsigned.id, ["expired"], 240_000);
  const reprepared = await api("POST", `/v1/operations/${unsigned.id}/prepare`);
  check(reprepared.status === 201 && reprepared.body.plan.attemptNo === 2, "new attempt after proven expiry");
  await signOp(reprepared.body, [w.treasury]);
  const retried = await waitOp(unsigned.id, ["finalized"]);
  record("unsigned plan expired with proof; attempt 2 signed and finalized", {
    firstBlockhash: expired.attempts[0].blockhash,
    secondBlockhash: retried.attempts[1].blockhash,
  });

  // Full replay: drop cursors and reprocess history; nothing is posted twice.
  const counts = async () =>
    (await db`SELECT (SELECT count(*) FROM postings)::int AS postings, (SELECT count(*) FROM chain_events)::int AS events,
                     (SELECT count(*) FROM webhook_outbox)::int AS outbox, (SELECT count(*) FROM exceptions)::int AS exceptions`)[0];
  const before = await counts();
  await stopProcess("worker");
  await db`DELETE FROM cursors`;
  startProcess("worker");
  await waitFor("indexer replay", async () => (await db`SELECT count(*)::int AS n FROM cursors`)[0].n >= 2);
  await sleep(3_000);
  const after = await counts();
  check(JSON.stringify(before) === JSON.stringify(after), `replay is idempotent ${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
  record("reconciler replay from empty cursors created no duplicate postings/events/webhooks", after);

  // ── Statement ─────────────────────────────────────────────────────────────────────────────
  const statement = await waitFor("reconciled statement", async () => {
    const s = (await api("GET", `/v1/vaults/${vault}/statement`)).body;
    return s.reconciliation.matches ? s : undefined;
  });
  check(statement.balanced, "postings balance");
  check(statement.postings.every((p: { signature: string; slot: string }) => p.signature && p.slot), "every posting links to a signature and slot");
  const cash = await tokenBalance(rpc, vaultTokens, "finalized");
  check(statement.reconciliation.ledgerCash === cash.toString(), "ledger cash equals finalized chain cash");
  const balances = Object.fromEntries(statement.balances.map((b: { account: string; balance: string }) => [b.account, formatTokenAmount(b.balance)]));
  record("statement balanced and reconciled to chain cash", { ledgerCash: formatTokenAmount(statement.reconciliation.ledgerCash), ...balances });

  await waitFor("webhook delivery", async () => (await db`SELECT count(*)::int AS n FROM webhook_outbox WHERE delivered_at IS NULL`)[0].n === 0);
  const uniqueIds = new Set(webhooks.map((e) => e.id));
  record("webhooks delivered at least once with stable event ids", { deliveries: webhooks.length, uniqueEvents: uniqueIds.size, outbox: after.outbox });

  console.log("\nStatement (finalized postings):");
  for (const p of statement.postings) {
    const amount = p.debit !== "0" ? `Dr ${formatTokenAmount(p.debit)}` : `Cr ${formatTokenAmount(p.credit)}`;
    console.log(`  slot ${p.slot}  ${p.entry.padEnd(20)} ${p.account.padEnd(22)} ${amount.padStart(18)}  ${p.business_ref ?? ""}  ${p.signature.slice(0, 12)}…`);
  }
  await db.close();
  receiver.stop(true);
}

const evidencePath = join(DEMO_DIR, "e2e-evidence.json");
try {
  await main();
  await Bun.write(evidencePath, JSON.stringify({ result: "passed", evidence }, null, 2));
  console.log(`\nE2E passed: ${evidence.length} checks. Evidence: ${evidencePath}`);
} catch (error) {
  await Bun.write(evidencePath, JSON.stringify({ result: "failed", error: String(error), evidence }, null, 2));
  console.error(`\nE2E FAILED: ${(error as Error).message}\nLogs: ${DEMO_DIR}/{api,worker}*.log`);
  process.exitCode = 1;
} finally {
  await stopProcess("worker").catch(() => undefined);
  await stopProcess("api").catch(() => undefined);
}


