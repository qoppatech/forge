import { generateKeyPair, getAddressEncoder, getAddressFromPublicKey } from "@solana/kit";
import {
  encodeForgeAccount,
  signPlanTransaction,
  type LoanAccount,
  type VaultAccount,
  type WithdrawalAccount,
} from "@forge/sdk";

import { createInstitution } from "../src/auth";
import { connect, resetDatabase, type Db } from "../src/db";
import { createServer } from "../src/server";
import { Worker } from "../src/worker";
import { FakeChain, randomAddress } from "./fake-chain";

export const TEST_DATABASE_URL =
  process.env.FORGE_TEST_DATABASE_URL ?? "postgres://forge@127.0.0.1:54329/forge_test";

const addressEncoder = getAddressEncoder();

export function tokenAccountData(mint: string, owner: string, amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  data.set(addressEncoder.encode(mint as never), 0);
  data.set(addressEncoder.encode(owner as never), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1; // initialized
  return data;
}

export interface Signer {
  address: string;
  pair: CryptoKeyPair;
}

async function signer(): Promise<Signer> {
  const pair = await generateKeyPair();
  return { pair, address: await getAddressFromPublicKey(pair.publicKey) };
}

export async function setup() {
  const db = connect(TEST_DATABASE_URL);
  await resetDatabase(db);
  const chain = new FakeChain();
  const server = createServer({ db, chain, host: "127.0.0.1", port: 0 });
  const bank = await createInstitution(db, "Demo Bank", "http://127.0.0.1:1/unused");
  const other = await createInstitution(db, "Other Bank");
  const roles = {
    treasury: await signer(),
    approverA: await signer(),
    approverB: await signer(),
    borrower: await signer(),
  };
  const mint = randomAddress();
  const accounts = {
    mint,
    source: randomAddress(),
    treasuryDestination: randomAddress(),
    borrowerTokens: randomAddress(),
  };
  chain.setAccount(accounts.borrowerTokens, tokenAccountData(mint, roles.borrower.address, 0n));
  const base = `http://127.0.0.1:${server.port}`;
  let counter = 0;

  async function api(
    method: string,
    path: string,
    body?: unknown,
    options: { key?: string | null; idempotencyKey?: string } = {},
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = options.key === undefined ? bank.apiKey : options.key;
    if (key) headers.authorization = `Bearer ${key}`;
    if (method === "POST") headers["idempotency-key"] = options.idempotencyKey ?? `key-${++counter}`;
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  /** Signs the operation's open plan locally and submits the signature. */
  async function sign(operation: any, ...signers: Signer[]) {
    const signed = await signPlanTransaction(operation.plan.transaction, signers.map((s) => s.pair));
    return api("POST", `/v1/operations/${operation.id}/signatures`, { transaction: signed });
  }

  const worker = (id = "w1") => new Worker(db, chain, { workerId: id, tickMs: 1_000, indexEveryTicks: 1 });

  async function lastSent(): Promise<string> {
    const wire = chain.sent.at(-1);
    if (!wire) throw new Error("nothing sent");
    return wire;
  }

  function vaultAccount(intent: any, overrides: Partial<VaultAccount> = {}): VaultAccount {
    return {
      treasury: intent.treasury,
      vaultId: intent.vaultId,
      mint: intent.mint,
      tokenAccount: intent.vaultTokenAccount,
      approvers: intent.approvers,
      treasuryDestination: intent.treasuryDestination,
      perLoanLimit: BigInt(intent.perLoanLimit),
      outstandingLimit: BigInt(intent.outstandingLimit),
      outstandingPrincipal: 0n,
      disbursementPaused: false,
      pauseSeq: 0n,
      bump: 255,
      ...overrides,
    };
  }

  function setVault(intent: any, overrides: Partial<VaultAccount> = {}, cash = 0n) {
    chain.setAccount(intent.vault, encodeForgeAccount("Vault", vaultAccount(intent, overrides)));
    chain.setAccount(intent.vaultTokenAccount, tokenAccountData(intent.mint, intent.vault, cash));
  }

  function setLoan(address: string, loan: LoanAccount) {
    chain.setAccount(address, encodeForgeAccount("Loan", loan));
  }

  function setWithdrawal(address: string, withdrawal: WithdrawalAccount) {
    chain.setAccount(address, encodeForgeAccount("Withdrawal", withdrawal));
  }

  /** Creates the demo vault through the API and lands it, returning the create intent. */
  async function createVault(reference = "main") {
    const created = await api("POST", "/v1/vaults", {
      reference,
      treasury: roles.treasury.address,
      mint,
      treasuryDestination: accounts.treasuryDestination,
      approvers: [roles.approverA.address, roles.approverB.address],
      perLoanLimit: "5000000000",
      outstandingLimit: "10000000000",
    });
    if (created.status !== 201) throw new Error(JSON.stringify(created.body));
    await sign(created.body, roles.treasury);
    await chain.land(await lastSent());
    setVault(created.body.intent);
    await worker().tick();
    return { operation: created.body, intent: created.body.intent };
  }

  async function close() {
    server.stop(true);
    await db.close();
  }

  return { db: db as Db, chain, server, bank, other, roles, accounts, api, sign, worker, lastSent, setVault, setLoan, setWithdrawal, vaultAccount, createVault, close };
}

export type Harness = Awaited<ReturnType<typeof setup>>;
