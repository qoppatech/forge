import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Address } from "@solana/kit";

import { airdrop, createMint, createRpc, createTokenAccount, mintTo, newWallet, type Wallet } from "./lib";

export const ROOT = join(import.meta.dir, "..", "..", "..");
export const DEMO_DIR = join(ROOT, ".local", "demo");

export interface Session {
  rpcUrl: string;
  apiUrl: string;
  institutionId: string;
  apiKey: string;
  otherApiKey: string;
  /** Demonstration wallets: seeds live only in this ignored file and the signer processes. */
  wallets: Record<"treasury" | "approverA" | "approverB" | "borrower" | "outsider", { address: string; seed: string }>;
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

async function createInstitution(databaseUrl: string, name: string, webhookUrl?: string) {
  const args = [process.execPath, join(ROOT, "apps/api/src/cli.ts"), "create-institution", "--name", name];
  if (webhookUrl) args.push("--webhook-url", webhookUrl);
  const proc = Bun.spawn(args, { env: { ...process.env, FORGE_DATABASE_URL: databaseUrl }, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`create-institution failed for ${name}`);
  return JSON.parse(output.trim().split("\n").at(-1)!) as { institutionId: string; apiKey: string };
}

/**
 * Local fixtures: independent demonstration wallets, a six-decimal FORGE_TEST_USD mint whose
 * authority is the fixture treasury (disclosed), 10,000 tokens for funding and 100 tokens of
 * disclosed borrower interest funding. Everything is disposable loopback state.
 */
export async function seed(options: { rpcUrl: string; apiUrl: string; databaseUrl: string; webhookUrl?: string }): Promise<Session> {
  const rpc = createRpc(options.rpcUrl);
  const wallets: Record<string, Wallet> = {};
  for (const name of ["treasury", "approverA", "approverB", "borrower", "outsider"]) {
    wallets[name] = await newWallet(name);
    await airdrop(rpc, wallets[name]!.address, 10);
  }
  const treasury = wallets.treasury!;
  const mint = await createMint(rpc, treasury.signer, treasury.address, 6);
  const treasurySource = await createTokenAccount(rpc, treasury.signer, mint, treasury.address);
  const treasuryDestination = await createTokenAccount(rpc, treasury.signer, mint, treasury.address);
  const borrowerTokens = await createTokenAccount(rpc, treasury.signer, mint, wallets.borrower!.address);
  const outsiderTokens = await createTokenAccount(rpc, treasury.signer, mint, wallets.outsider!.address);
  await mintTo(rpc, treasury.signer, mint, treasurySource, FUNDING);
  await mintTo(rpc, treasury.signer, mint, borrowerTokens, BORROWER_INTEREST_FUNDING);

  const bank = await createInstitution(options.databaseUrl, "Demo Bank", options.webhookUrl);
  const other = await createInstitution(options.databaseUrl, "Other Bank");
  return {
    rpcUrl: options.rpcUrl,
    apiUrl: options.apiUrl,
    institutionId: bank.institutionId,
    apiKey: bank.apiKey,
    otherApiKey: other.apiKey,
    wallets: Object.fromEntries(
      Object.entries(wallets).map(([name, w]) => [name, { address: w.address, seed: w.seedHex }]),
    ) as unknown as Session["wallets"],
    accounts: { mint, treasurySource, treasuryDestination, borrowerTokens, outsiderTokens },
  };
}

export async function writeSession(session: Session) {
  await mkdir(DEMO_DIR, { recursive: true });
  const path = join(DEMO_DIR, "session.json");
  await Bun.write(path, JSON.stringify(session, null, 2));
  return path;
}

export type { Address };

if (import.meta.main) {
  const session = await seed({
    rpcUrl: process.env.FORGE_RPC_URL ?? "http://127.0.0.1:8899",
    apiUrl: process.env.FORGE_API_URL ?? "http://127.0.0.1:3002",
    databaseUrl: process.env.FORGE_DATABASE_URL ?? "postgres://forge@127.0.0.1:54329/forge",
  });
  const path = await writeSession(session);
  console.log(`seeded demo wallets, mint ${session.accounts.mint} and institutions → ${path}`);
}
