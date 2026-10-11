import { base64ToBytes, sha256Hex } from "@forge/sdk";
import {
  createSolanaRpc,
  getAddressDecoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import type { Address, Signature } from "@solana/kit";

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
  getLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: bigint;
  }>;
  getBlockHeight: (commitment: Commitment) => Promise<bigint>;
  /** Broadcasts signed bytes without preflight; returns the transaction signature. */
  sendTransaction: (wireBase64: string) => Promise<string>;
  getSignatureStatuses: (
    signatures: string[]
  ) => Promise<(SignatureStatus | null)[]>;
  /** Finalized transaction or null when unknown / not yet finalized. */
  getTransaction: (signature: string) => Promise<ChainTransaction | null>;
  /** Finalized signatures touching `address`, newest first, strictly after `until`. */
  getSignaturesForAddress: (
    address: string,
    options: { until?: string; before?: string; limit: number }
  ) => Promise<SignatureInfo[]>;
  getAccounts: (
    addresses: string[],
    commitment: Commitment
  ) => Promise<(AccountSnapshot | null)[]>;
}

/** A compiled top-level instruction, as decoded from the transaction message. */
interface CompiledInstruction {
  readonly programAddressIndex: number;
  readonly accountIndices?: readonly number[];
  readonly data?: ArrayLike<number>;
}

/** CPI instructions recorded by the node for one top-level instruction. */
interface InnerInstructionGroup {
  readonly index: number;
  readonly instructions: readonly {
    readonly programIdIndex: number;
    readonly accounts: readonly number[];
    readonly data: string;
  }[];
}

/** A pre- or post-transaction SPL token balance reported by the node. */
interface RpcTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string };
}

const base58 = getBase58Encoder();
const addressDecoder = getAddressDecoder();

/** Reads mint, owner and amount from an SPL Token account (legacy layout). */
export function parseTokenAccount(data: Uint8Array): TokenAccount | null {
  if (data.length < 72) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    amount: view.getBigUint64(64, true),
    mint: addressDecoder.decode(data.subarray(0, 32)),
    owner: addressDecoder.decode(data.subarray(32, 64)),
  };
}

/** Top-level instructions first, then each group of inner (CPI) instructions, in node order. */
function collectInstructions(
  topLevel: readonly CompiledInstruction[],
  innerGroups: readonly InnerInstructionGroup[],
  keys: readonly string[]
): ChainInstruction[] {
  const instructions: ChainInstruction[] = [];
  for (const [index, ix] of topLevel.entries()) {
    instructions.push({
      accounts: (ix.accountIndices ?? []).map((i) => keys[i] ?? ""),
      data: new Uint8Array(ix.data ?? []),
      index,
      innerIndex: -1,
      programAddress: keys[ix.programAddressIndex] ?? "",
    });
  }
  for (const group of innerGroups) {
    for (const [innerIndex, ix] of group.instructions.entries()) {
      instructions.push({
        accounts: ix.accounts.map((i) => keys[i] ?? ""),
        data: new Uint8Array(base58.encode(ix.data)),
        index: group.index,
        innerIndex,
        programAddress: keys[ix.programIdIndex] ?? "",
      });
    }
  }
  return instructions;
}

/** Pairs pre- and post-transaction token balances per account. */
function collectTokenBalances(
  pre: readonly RpcTokenBalance[],
  post: readonly RpcTokenBalance[],
  keys: readonly string[]
): TokenBalanceChange[] {
  const balances = new Map<string, TokenBalanceChange>();
  for (const [phase, list] of [
    ["pre", pre],
    ["post", post],
  ] as const) {
    for (const b of list) {
      const account = keys[b.accountIndex] ?? "";
      const entry = balances.get(account) ?? {
        account,
        mint: b.mint,
        owner: b.owner ?? "",
        post: 0n,
        pre: 0n,
      };
      entry[phase] = BigInt(b.uiTokenAmount.amount);
      balances.set(account, entry);
    }
  }
  return [...balances.values()];
}

export class RpcChain implements Chain {
  readonly network: string;
  private readonly rpc;

  constructor(url: string, network: string) {
    this.network = network;
    this.rpc = createSolanaRpc(url);
  }

  async getLatestBlockhash() {
    const { value } = await this.rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    return {
      blockhash: value.blockhash as string,
      lastValidBlockHeight: value.lastValidBlockHeight,
    };
  }

  async getBlockHeight(commitment: Commitment) {
    return await this.rpc.getBlockHeight({ commitment }).send();
  }

  async sendTransaction(wireBase64: string) {
    return await this.rpc
      .sendTransaction(wireBase64 as never, {
        encoding: "base64",
        maxRetries: 0n,
        skipPreflight: true,
      })
      .send();
  }

  async getSignatureStatuses(signatures: string[]) {
    if (signatures.length === 0) {
      return [];
    }
    const { value } = await this.rpc
      .getSignatureStatuses(signatures as Signature[], {
        searchTransactionHistory: true,
      })
      .send();
    return value.map((s) =>
      s
        ? {
            confirmationStatus: (s.confirmationStatus ??
              null) as Commitment | null,
            err: s.err,
            slot: s.slot,
          }
        : null
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
    if (!response) {
      return null;
    }
    const raw = getTransactionDecoder().decode(
      base64ToBytes(response.transaction[0])
    );
    const compiled = getCompiledTransactionMessageDecoder().decode(
      raw.messageBytes
    );
    if (compiled.version === 1) {
      throw new Error("v1 transactions are not requested");
    }
    const { meta } = response;
    const loaded =
      meta && "loadedAddresses" in meta && meta.loadedAddresses
        ? [...meta.loadedAddresses.writable, ...meta.loadedAddresses.readonly]
        : [];
    const keys: string[] = [...compiled.staticAccounts, ...loaded];
    const instructions = collectInstructions(
      compiled.instructions,
      meta?.innerInstructions ?? [],
      keys
    );
    const tokenBalances = collectTokenBalances(
      meta?.preTokenBalances ?? [],
      meta?.postTokenBalances ?? [],
      keys
    );
    return {
      blockTime: response.blockTime ?? null,
      blockhash: String(compiled.lifetimeToken),
      err: meta?.err ?? null,
      feePayer: compiled.staticAccounts[0] ?? "",
      instructions,
      logs: [...(meta?.logMessages ?? [])],
      messageHash: await sha256Hex(new Uint8Array(raw.messageBytes)),
      signature,
      slot: response.slot,
      tokenBalances,
    };
  }

  async getSignaturesForAddress(
    address: string,
    options: { until?: string; before?: string; limit: number }
  ) {
    const result = await this.rpc
      .getSignaturesForAddress(address as Address, {
        commitment: "finalized",
        limit: options.limit,
        ...(options.until ? { until: options.until as Signature } : {}),
        ...(options.before ? { before: options.before as Signature } : {}),
      })
      .send();
    return result.map((s) => ({
      err: s.err,
      signature: s.signature as string,
      slot: s.slot,
    }));
  }

  async getAccounts(addresses: string[], commitment: Commitment) {
    if (addresses.length === 0) {
      return [];
    }
    const { value } = await this.rpc
      .getMultipleAccounts(addresses as Address[], {
        commitment,
        encoding: "base64",
      })
      .send();
    return value.map((account) =>
      account
        ? {
            data: base64ToBytes(account.data[0]),
            lamports: account.lamports,
            owner: account.owner as string,
          }
        : null
    );
  }
}
