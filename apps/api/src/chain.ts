import {
  createSolanaRpc,
  getAddressDecoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
  type Signature,
} from "@solana/kit";
import { base64ToBytes, sha256Hex } from "@forge/sdk";

export type Commitment = "processed" | "confirmed" | "finalized";

export interface SignatureStatus {
  slot: bigint;
  err: unknown | null;
  confirmationStatus: Commitment | null;
}

export interface ChainInstruction {
  programAddress: string;
  accounts: string[];
  data: Uint8Array;
  /** Top-level instruction index. */
  index: number;
  /** Position within the CPI list of `index`; -1 for the top-level instruction itself. */
  innerIndex: number;
}

export interface TokenBalanceChange {
  account: string;
  mint: string;
  owner: string;
  pre: bigint;
  post: bigint;
}

/** A finalized transaction, normalized for the reconciler. */
export interface ChainTransaction {
  signature: string;
  slot: bigint;
  blockTime: bigint | null;
  err: unknown | null;
  feePayer: string;
  blockhash: string;
  messageHash: string;
  instructions: ChainInstruction[];
  tokenBalances: TokenBalanceChange[];
  logs: string[];
}

export interface AccountSnapshot {
  owner: string;
  lamports: bigint;
  data: Uint8Array;
}

export interface TokenAccount {
  mint: string;
  owner: string;
  amount: bigint;
}

export interface SignatureInfo {
  signature: string;
  slot: bigint;
  err: unknown | null;
}

/**
 * Everything the API and worker need from Solana. The RPC implementation talks to a node;
 * tests substitute a deterministic fake to exercise crash, timeout and expiry paths.
 */
export interface Chain {
  readonly network: string;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  getBlockHeight(commitment: Commitment): Promise<bigint>;
  /** Broadcasts signed bytes without preflight; returns the transaction signature. */
  sendTransaction(wireBase64: string): Promise<string>;
  getSignatureStatuses(signatures: string[]): Promise<(SignatureStatus | null)[]>;
  /** Finalized transaction or null when unknown / not yet finalized. */
  getTransaction(signature: string): Promise<ChainTransaction | null>;
  /** Finalized signatures touching `address`, newest first, strictly after `until`. */
  getSignaturesForAddress(
    address: string,
    options: { until?: string; before?: string; limit: number },
  ): Promise<SignatureInfo[]>;
  getAccounts(addresses: string[], commitment: Commitment): Promise<(AccountSnapshot | null)[]>;
}

const base58 = getBase58Encoder();
const addressDecoder = getAddressDecoder();

/** Reads mint, owner and amount from an SPL Token account (legacy layout). */
export function parseTokenAccount(data: Uint8Array): TokenAccount | null {
  if (data.length < 72) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: addressDecoder.decode(data.subarray(0, 32)),
    owner: addressDecoder.decode(data.subarray(32, 64)),
    amount: view.getBigUint64(64, true),
  };
}

export class RpcChain implements Chain {
  private readonly rpc;

  constructor(
    url: string,
    readonly network: string,
  ) {
    this.rpc = createSolanaRpc(url);
  }

  async getLatestBlockhash() {
    const { value } = await this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    return { blockhash: value.blockhash as string, lastValidBlockHeight: value.lastValidBlockHeight };
  }

  async getBlockHeight(commitment: Commitment) {
    return await this.rpc.getBlockHeight({ commitment }).send();
  }

  async sendTransaction(wireBase64: string) {
    return await this.rpc
      .sendTransaction(wireBase64 as never, {
        encoding: "base64",
        skipPreflight: true,
        maxRetries: 0n,
      })
      .send();
  }

  async getSignatureStatuses(signatures: string[]) {
    if (signatures.length === 0) return [];
    const { value } = await this.rpc
      .getSignatureStatuses(signatures as Signature[], { searchTransactionHistory: true })
      .send();
    return value.map((s) =>
      s
        ? {
            slot: s.slot,
            err: s.err,
            confirmationStatus: (s.confirmationStatus ?? null) as Commitment | null,
          }
        : null,
    );
  }

  async getTransaction(signature: string): Promise<ChainTransaction | null> {
    const response = await this.rpc
      .getTransaction(signature as Signature, {
        commitment: "finalized",
        encoding: "base64",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (!response) return null;
    const raw = getTransactionDecoder().decode(base64ToBytes(response.transaction[0]));
    const compiled = getCompiledTransactionMessageDecoder().decode(raw.messageBytes);
    if (compiled.version === 1) throw new Error("v1 transactions are not requested");
    const meta = response.meta;
    const loaded = meta && "loadedAddresses" in meta && meta.loadedAddresses
      ? [...meta.loadedAddresses.writable, ...meta.loadedAddresses.readonly]
      : [];
    const keys: string[] = [...compiled.staticAccounts, ...loaded];
    const instructions: ChainInstruction[] = [];
    compiled.instructions.forEach((ix, index) => {
      instructions.push({
        programAddress: keys[ix.programAddressIndex] ?? "",
        accounts: (ix.accountIndices ?? []).map((i) => keys[i] ?? ""),
        data: new Uint8Array(ix.data ?? []),
        index,
        innerIndex: -1,
      });
    });
    for (const group of meta?.innerInstructions ?? []) {
      group.instructions.forEach((ix, innerIndex) => {
        instructions.push({
          programAddress: keys[ix.programIdIndex] ?? "",
          accounts: ix.accounts.map((i) => keys[i] ?? ""),
          data: new Uint8Array(base58.encode(ix.data)),
          index: group.index,
          innerIndex,
        });
      });
    }
    const balances = new Map<string, TokenBalanceChange>();
    for (const [phase, list] of [
      ["pre", meta?.preTokenBalances ?? []],
      ["post", meta?.postTokenBalances ?? []],
    ] as const) {
      for (const b of list) {
        const account = keys[b.accountIndex] ?? "";
        const entry = balances.get(account) ?? {
          account,
          mint: b.mint,
          owner: b.owner ?? "",
          pre: 0n,
          post: 0n,
        };
        entry[phase] = BigInt(b.uiTokenAmount.amount);
        balances.set(account, entry);
      }
    }
    return {
      signature,
      slot: response.slot,
      blockTime: response.blockTime ?? null,
      err: meta?.err ?? null,
      feePayer: compiled.staticAccounts[0] ?? "",
      blockhash: String(compiled.lifetimeToken),
      messageHash: await sha256Hex(new Uint8Array(raw.messageBytes)),
      instructions,
      tokenBalances: [...balances.values()],
      logs: [...(meta?.logMessages ?? [])],
    };
  }

  async getSignaturesForAddress(
    address: string,
    options: { until?: string; before?: string; limit: number },
  ) {
    const result = await this.rpc
      .getSignaturesForAddress(address as Address, {
        commitment: "finalized",
        limit: options.limit,
        ...(options.until ? { until: options.until as Signature } : {}),
        ...(options.before ? { before: options.before as Signature } : {}),
      })
      .send();
    return result.map((s) => ({ signature: s.signature as string, slot: s.slot, err: s.err }));
  }

  async getAccounts(addresses: string[], commitment: Commitment) {
    if (addresses.length === 0) return [];
    const { value } = await this.rpc
      .getMultipleAccounts(addresses as Address[], { encoding: "base64", commitment })
      .send();
    return value.map((account) =>
      account
        ? {
            owner: account.owner as string,
            lamports: account.lamports,
            data: base64ToBytes(account.data[0]),
          }
        : null,
    );
  }
}
