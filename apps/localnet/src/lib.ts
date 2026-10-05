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
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc as KitRpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  getInitializeAccount3Instruction,
  getInitializeMint2Instruction,
  getMintToCheckedInstruction,
} from "@solana-program/token";
import { bytesToHex, hexToBytes } from "@forge/sdk";

/** Loopback validator RPC, including test-cluster methods such as `requestAirdrop`. */
export type Rpc = KitRpc<SolanaRpcApi>;

export const createRpc = (url: string) => createSolanaRpc(url) as unknown as Rpc;

/** A demonstration wallet. Its seed exists only in the local harness and ignored files. */
export interface Wallet {
  name: string;
  address: Address;
  seedHex: string;
  keyPair: CryptoKeyPair;
  signer: KeyPairSigner;
}

export async function walletFromSeed(name: string, seedHex: string): Promise<Wallet> {
  const keyPair = await createKeyPairFromPrivateKeyBytes(hexToBytes(seedHex, 32));
  const signer = await createSignerFromKeyPair(keyPair);
  return { name, address: signer.address, seedHex, keyPair, signer };
}

export function newWallet(name: string): Promise<Wallet> {
  return walletFromSeed(name, bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined | null | false>,
  { timeoutMs = 120_000, intervalMs = 500 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

export async function waitForSignature(
  rpc: Rpc,
  signature: string,
  commitment: "confirmed" | "finalized" = "confirmed",
): Promise<{ err: unknown | null; slot: bigint }> {
  return waitFor(`signature ${signature.slice(0, 8)}… ${commitment}`, async () => {
    const { value } = await rpc.getSignatureStatuses([signature as Signature], { searchTransactionHistory: true }).send();
    const status = value[0];
    if (!status) return undefined;
    const done =
      commitment === "confirmed"
        ? status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized"
        : status.confirmationStatus === "finalized";
    return done ? { err: status.err, slot: status.slot } : undefined;
  });
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
  { expectFailure = false } = {},
): Promise<{ signature: string; err: unknown | null }> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: "base64",
      skipPreflight: expectFailure,
      preflightCommitment: "confirmed",
    })
    .send();
  const { err } = await waitForSignature(rpc, signature);
  if (err && !expectFailure) throw new Error(`Fixture transaction failed: ${JSON.stringify(err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return { signature, err };
}

export async function airdrop(rpc: Rpc, address: Address, sol: number) {
  const signature = await rpc.requestAirdrop(address, lamports(BigInt(sol) * 1_000_000_000n)).send();
  await waitForSignature(rpc, signature);
}

export async function createMint(rpc: Rpc, payer: KeyPairSigner, authority: Address, decimals: number) {
  const mint = (await newWallet("mint")).signer;
  const space = 82n;
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await send(rpc, payer, [
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals, mintAuthority: authority, freezeAuthority: null }),
  ]);
  return mint.address;
}

export async function createTokenAccount(rpc: Rpc, payer: KeyPairSigner, mint: Address, owner: Address) {
  const account = (await newWallet("token")).signer;
  const space = 165n;
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await send(rpc, payer, [
    getCreateAccountInstruction({ payer, newAccount: account, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeAccount3Instruction({ account: account.address, mint, owner }),
  ]);
  return account.address;
}

export async function mintTo(rpc: Rpc, authority: KeyPairSigner, mint: Address, token: Address, amount: bigint) {
  await send(rpc, authority, [
    getMintToCheckedInstruction({ mint, token, mintAuthority: authority, amount, decimals: 6 }),
  ]);
}

export async function tokenBalance(rpc: Rpc, account: Address, commitment: "confirmed" | "finalized" = "confirmed") {
  const { value } = await rpc.getTokenAccountBalance(account, { commitment }).send();
  return BigInt(value.amount);
}
