import { encodeForgeAccount, signPlanTransaction } from "@forge/sdk";
import type {
  ForgeIntent,
  LoanAccount,
  VaultAccount,
  WithdrawalAccount,
} from "@forge/sdk";
import {
  generateKeyPair,
  getAddressEncoder,
  getAddressFromPublicKey,
} from "@solana/kit";

import { createInstitution } from "../src/auth";
import { connect, resetDatabase } from "../src/db";
import type { Db } from "../src/db";
import { createServer } from "../src/server";
import { Worker } from "../src/worker";
import { FakeChain, randomAddress } from "./fake-chain";

export const TEST_DATABASE_URL =
  process.env.FORGE_TEST_DATABASE_URL ??
  "postgres://forge@127.0.0.1:54329/forge_test";

const addressEncoder = getAddressEncoder();

export function tokenAccountData(
  mint: string,
  owner: string,
  amount: bigint
): Uint8Array {
  const data = new Uint8Array(165);
  data.set(addressEncoder.encode(mint as never), 0);
  data.set(addressEncoder.encode(owner as never), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  // initialized
  data[108] = 1;
  return data;
}

export interface Signer {
  address: string;
  pair: CryptoKeyPair;
}

type CreateVaultIntent = Extract<ForgeIntent, { kind: "create_vault" }>;

// oxlint-disable-next-line typescript/no-explicit-any -- response bodies are untyped JSON; tests assert on their shape
type ResponseBody = any;

function vaultAccount(
  intent: CreateVaultIntent,
  overrides: Partial<VaultAccount> = {}
): VaultAccount {
  return {
    approvers: intent.approvers,
    bump: 255,
    disbursementPaused: false,
    mint: intent.mint,
    outstandingLimit: BigInt(intent.outstandingLimit),
    outstandingPrincipal: 0n,
    pauseSeq: 0n,
    perLoanLimit: BigInt(intent.perLoanLimit),
    tokenAccount: intent.vaultTokenAccount,
    treasury: intent.treasury,
    treasuryDestination: intent.treasuryDestination,
    vaultId: intent.vaultId,
    ...overrides,
  };
}

async function signer(): Promise<Signer> {
  const pair = await generateKeyPair();
  return { address: await getAddressFromPublicKey(pair.publicKey), pair };
}

export async function setup() {
  const db = connect(TEST_DATABASE_URL);
  await resetDatabase(db);
  const chain = new FakeChain();
  const server = createServer({ chain, db, host: "127.0.0.1", port: 0 });
  const bank = await createInstitution(
    db,
    "Demo Bank",
    "http://127.0.0.1:1/unused"
  );
  const other = await createInstitution(db, "Other Bank");
  const roles = {
    approverA: await signer(),
    approverB: await signer(),
    borrower: await signer(),
    treasury: await signer(),
  };
  const mint = randomAddress();
  const accounts = {
    borrowerTokens: randomAddress(),
    mint,
    source: randomAddress(),
    treasuryDestination: randomAddress(),
  };
  chain.setAccount(
    accounts.borrowerTokens,
    tokenAccountData(mint, roles.borrower.address, 0n)
  );
  const base = `http://127.0.0.1:${server.port}`;
  let counter = 0;
  const nextIdempotencyKey = () => {
    counter += 1;
    return `key-${counter}`;
  };

  async function api(
    method: string,
    path: string,
    body?: unknown,
    options: { key?: string | null; idempotencyKey?: string } = {}
  ): Promise<{ status: number; body: ResponseBody }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const key = options.key === undefined ? bank.apiKey : options.key;
    if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    if (method === "POST") {
      headers["idempotency-key"] =
        options.idempotencyKey ?? nextIdempotencyKey();
    }
    const response = await fetch(`${base}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    });
    return { body: await response.json(), status: response.status };
  }

  /** Signs the operation's open plan locally and submits the signature. */
  async function sign(
    operation: { id: string; plan: { transaction: string } },
    ...signers: Signer[]
  ) {
    const signed = await signPlanTransaction(
      operation.plan.transaction,
      signers.map((s) => s.pair)
    );
    return api("POST", `/v1/operations/${operation.id}/signatures`, {
      transaction: signed,
    });
  }

  const worker = (id = "w1") =>
    new Worker(db, chain, { indexEveryTicks: 1, tickMs: 1000, workerId: id });

  function lastSent(): Promise<string> {
    const wire = chain.sent.at(-1);
    return wire
      ? Promise.resolve(wire)
      : Promise.reject(new Error("nothing sent"));
  }

  function setVault(
    intent: CreateVaultIntent,
    overrides: Partial<VaultAccount> = {},
    cash = 0n
  ) {
    chain.setAccount(
      intent.vault,
      encodeForgeAccount("Vault", vaultAccount(intent, overrides))
    );
    chain.setAccount(
      intent.vaultTokenAccount,
      tokenAccountData(intent.mint, intent.vault, cash)
    );
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
      approvers: [roles.approverA.address, roles.approverB.address],
      mint,
      outstandingLimit: "10000000000",
      perLoanLimit: "5000000000",
      reference,
      treasury: roles.treasury.address,
      treasuryDestination: accounts.treasuryDestination,
    });
    if (created.status !== 201) {
      throw new Error(JSON.stringify(created.body));
    }
    await sign(created.body, roles.treasury);
    await chain.land(await lastSent());
    setVault(created.body.intent);
    await worker().tick();
    return { intent: created.body.intent, operation: created.body };
  }

  async function close() {
    server.stop(true);
    await db.close();
  }

  return {
    accounts,
    api,
    bank,
    chain,
    close,
    createVault,
    db: db as Db,
    lastSent,
    other,
    roles,
    server,
    setLoan,
    setVault,
    setWithdrawal,
    sign,
    vaultAccount,
    worker,
  };
}

export type Harness = Awaited<ReturnType<typeof setup>>;
