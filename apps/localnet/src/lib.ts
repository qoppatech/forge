import { bytesToHex, hexToBytes } from "@forge/sdk";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  getInitializeAccount3Instruction,
  getInitializeMint2Instruction,
  getMintToCheckedInstruction,
} from "@solana-program/token";
import {
  appendTransactionMessageInstructions,
  createKeyPairFromPrivateKeyBytes,
  createSignerFromKeyPair,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import type {
  Address,
  Instruction,
  KeyPairSigner,
  Rpc as KitRpc,
  Signature,
  SolanaRpcApi,
} from "@solana/kit";

/** Loopback validator RPC, including test-cluster methods such as `requestAirdrop`. */
export type Rpc = KitRpc<SolanaRpcApi>;

export const createRpc = (url: string) =>
  createSolanaRpc(url) as unknown as Rpc;

/** A demonstration wallet. Its seed exists only in the local harness and ignored files. */
export interface Wallet {
  name: string;
  address: Address;
  seedHex: string;
  keyPair: CryptoKeyPair;
  signer: KeyPairSigner;
}

export async function walletFromSeed(
  name: string,
  seedHex: string
): Promise<Wallet> {
  const keyPair = await createKeyPairFromPrivateKeyBytes(
    hexToBytes(seedHex, 32)
  );
  const signer = await createSignerFromKeyPair(keyPair);
  return { address: signer.address, keyPair, name, seedHex, signer };
}

export function newWallet(name: string): Promise<Wallet> {
  return walletFromSeed(
    name,
    bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
  );
}

export const sleep = (ms: number) => Bun.sleep(ms);

export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined | null | false>,
  { timeoutMs = 120_000, intervalMs = 500 } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling: each attempt must finish before the next
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- polling: wait between attempts
    await sleep(intervalMs);
  }
}

export function waitForSignature(
  rpc: Rpc,
  signature: string,
  commitment: "confirmed" | "finalized" = "confirmed"
): Promise<{ err: unknown | null; slot: bigint }> {
  return waitFor(
    `signature ${signature.slice(0, 8)}… ${commitment}`,
    async () => {
      const { value } = await rpc
        .getSignatureStatuses([signature as Signature], {
          searchTransactionHistory: true,
        })
        .send();
      const [status] = value;
      if (!status) {
        return;
      }
      const done =
        commitment === "confirmed"
          ? status.confirmationStatus === "confirmed" ||
            status.confirmationStatus === "finalized"
          : status.confirmationStatus === "finalized";
      return done ? { err: status.err, slot: status.slot } : undefined;
    }
  );
}

/**
 * Signs and sends fixture instructions with kit signers. `expectFailure` sends without
 * preflight so a rejected instruction lands (fee paid, no state change) and its error is
 * returned for assertion.
 */
export async function send(
  rpc: Rpc,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
  { expectFailure = false } = {}
): Promise<{ signature: string; err: unknown | null }> {
  const { value: blockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      preflightCommitment: "confirmed",
      skipPreflight: expectFailure,
    })
    .send();
  const { err } = await waitForSignature(rpc, signature);
  if (err && !expectFailure) {
    throw new Error(
      `Fixture transaction failed: ${JSON.stringify(err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`
    );
  }
  return { err, signature };
}

export async function airdrop(rpc: Rpc, address: Address, sol: number) {
  const signature = await rpc
    .requestAirdrop(address, lamports(BigInt(sol) * 1_000_000_000n))
    .send();
  await waitForSignature(rpc, signature);
}

export async function createMint(
  rpc: Rpc,
  payer: KeyPairSigner,
  authority: Address,
  decimals: number
) {
  const { signer: mint } = await newWallet("mint");
  const space = 82n;
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await send(rpc, payer, [
    getCreateAccountInstruction({
      lamports: rent,
      newAccount: mint,
      payer,
      programAddress: TOKEN_PROGRAM_ADDRESS,
      space,
    }),
    getInitializeMint2Instruction({
      decimals,
      freezeAuthority: null,
      mint: mint.address,
      mintAuthority: authority,
    }),
  ]);
  return mint.address;
}

export async function createTokenAccount(
  rpc: Rpc,
  payer: KeyPairSigner,
  mint: Address,
  owner: Address
) {
  const { signer: account } = await newWallet("token");
  const space = 165n;
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await send(rpc, payer, [
    getCreateAccountInstruction({
      lamports: rent,
      newAccount: account,
      payer,
      programAddress: TOKEN_PROGRAM_ADDRESS,
      space,
    }),
    getInitializeAccount3Instruction({ account: account.address, mint, owner }),
  ]);
  return account.address;
}

export async function mintTo(
  rpc: Rpc,
  authority: KeyPairSigner,
  mint: Address,
  token: Address,
  amount: bigint
) {
  await send(rpc, authority, [
    getMintToCheckedInstruction({
      amount,
      decimals: 6,
      mint,
      mintAuthority: authority,
      token,
    }),
  ]);
}

export async function tokenBalance(
  rpc: Rpc,
  account: Address,
  commitment: "confirmed" | "finalized" = "confirmed"
) {
  const { value } = await rpc
    .getTokenAccountBalance(account, { commitment })
    .send();
  return BigInt(value.amount);
}
