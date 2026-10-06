import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  airdrop,
  createMint,
  createRpc,
  createTokenAccount,
  mintTo,
  newWallet,
} from "./lib";
import type { Wallet } from "./lib";

export const ROOT = path.join(import.meta.dir, "..", "..", "..");
export const DEMO_DIR = path.join(ROOT, ".local", "demo");

export interface Session {
  rpcUrl: string;
  apiUrl: string;
  institutionId: string;
  apiKey: string;
  otherApiKey: string;
  /** Demonstration wallets: seeds live only in this ignored file and the signer processes. */
  wallets: Record<
    "treasury" | "approverA" | "approverB" | "borrower" | "outsider",
    { address: string; seed: string }
  >;
  accounts: {
    mint: string;
    treasurySource: string;
    treasuryDestination: string;
    borrowerTokens: string;
    outsiderTokens: string;
  };
}

export const FUNDING = 10_000_000_000n;
export const BORROWER_INTEREST_FUNDING = 100_000_000n;

async function createInstitution(
  databaseUrl: string,
  name: string,
  webhookUrl?: string
) {
  const args = [
    process.execPath,
    path.join(ROOT, "apps/api/src/cli.ts"),
    "create-institution",
    "--name",
    name,
  ];
  if (webhookUrl) {
    args.push("--webhook-url", webhookUrl);
  }
  const proc = Bun.spawn(args, {
    env: { ...process.env, FORGE_DATABASE_URL: databaseUrl },
    stderr: "inherit",
    stdout: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`create-institution failed for ${name}`);
  }
  return JSON.parse(output.trim().split("\n").at(-1) ?? "") as {
    institutionId: string;
    apiKey: string;
  };
}

/**
 * Local fixtures: independent demonstration wallets, a six-decimal FORGE_TEST_USD mint whose
 * authority is the fixture treasury (disclosed), 10,000 tokens for funding and 100 tokens of
 * disclosed borrower interest funding. Everything is disposable loopback state.
 */
export async function seed(options: {
  rpcUrl: string;
  apiUrl: string;
  databaseUrl: string;
  webhookUrl?: string;
}): Promise<Session> {
  const rpc = createRpc(options.rpcUrl);
  const wallets: Record<string, Wallet> = {};
  for (const name of [
    "treasury",
    "approverA",
    "approverB",
    "borrower",
    "outsider",
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture wallets are created and funded one at a time
    const wallet = await newWallet(name);
    wallets[name] = wallet;
    // oxlint-disable-next-line no-await-in-loop -- each airdrop is confirmed before the next wallet
    await airdrop(rpc, wallet.address, 10);
  }
  const { treasury, borrower, outsider } = wallets;
  if (!(treasury && borrower && outsider)) {
    throw new Error("fixture wallets missing");
  }
  const mint = await createMint(rpc, treasury.signer, treasury.address, 6);
  const treasurySource = await createTokenAccount(
    rpc,
    treasury.signer,
    mint,
    treasury.address
  );
  const treasuryDestination = await createTokenAccount(
    rpc,
    treasury.signer,
    mint,
    treasury.address
  );
  const borrowerTokens = await createTokenAccount(
    rpc,
    treasury.signer,
    mint,
    borrower.address
  );
  const outsiderTokens = await createTokenAccount(
    rpc,
    treasury.signer,
    mint,
    outsider.address
  );
  await mintTo(rpc, treasury.signer, mint, treasurySource, FUNDING);
  await mintTo(
    rpc,
    treasury.signer,
    mint,
    borrowerTokens,
    BORROWER_INTEREST_FUNDING
  );

  const bank = await createInstitution(
    options.databaseUrl,
    "Demo Bank",
    options.webhookUrl
  );
  const other = await createInstitution(options.databaseUrl, "Other Bank");
  return {
    accounts: {
      borrowerTokens,
      mint,
      outsiderTokens,
      treasuryDestination,
      treasurySource,
    },
    apiKey: bank.apiKey,
    apiUrl: options.apiUrl,
    institutionId: bank.institutionId,
    otherApiKey: other.apiKey,
    rpcUrl: options.rpcUrl,
    wallets: Object.fromEntries(
      Object.entries(wallets).map(([name, w]) => [
        name,
        { address: w.address, seed: w.seedHex },
      ])
    ) as unknown as Session["wallets"],
  };
}

export async function writeSession(session: Session) {
  await mkdir(DEMO_DIR, { recursive: true });
  const sessionPath = path.join(DEMO_DIR, "session.json");
  await Bun.write(sessionPath, JSON.stringify(session, null, 2));
  return sessionPath;
}

export type { Address } from "@solana/kit";

if (import.meta.main) {
  const session = await seed({
    apiUrl: process.env.FORGE_API_URL ?? "http://127.0.0.1:3002",
    databaseUrl:
      process.env.FORGE_DATABASE_URL ??
      "postgres://forge@127.0.0.1:54329/forge",
    rpcUrl: process.env.FORGE_RPC_URL ?? "http://127.0.0.1:8899",
  });
  const sessionPath = await writeSession(session);
  console.log(
    `seeded demo wallets, mint ${session.accounts.mint} and institutions → ${sessionPath}`
  );
}
