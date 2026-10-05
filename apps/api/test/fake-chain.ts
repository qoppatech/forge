import { getAddressDecoder } from "@solana/kit";
import {
  buildForgeInstruction,
  decodeWireTransaction,
  inspectTransaction,
  messageHash,
  transactionSignature,
  type ForgeIntent,
} from "@forge/sdk";

import type {
  AccountSnapshot,
  Chain,
  ChainTransaction,
  Commitment,
  SignatureInfo,
  SignatureStatus,
  TokenBalanceChange,
} from "../src/chain";

const addressDecoder = getAddressDecoder();
export const randomAddress = () => addressDecoder.decode(crypto.getRandomValues(new Uint8Array(32)));

/**
 * A programmable ledger for failure-mode tests. Nothing executes: tests decide when a
 * signature lands, at which commitment and with which error, and when blockhashes expire.
 */
export class FakeChain implements Chain {
  readonly network = "test";
  confirmedHeight = 1_000n;
  finalizedHeight = 968n;
  slot = 5_000n;
  rpcDown = false;
  /** When set, every plan gets this blockhash (two requests within one slot). */
  fixedBlockhash: string | undefined;
  sendFailure: Error | undefined;
  readonly sent: string[] = [];
  readonly statuses = new Map<string, SignatureStatus>();
  readonly transactions = new Map<string, ChainTransaction>();
  readonly history = new Map<string, SignatureInfo[]>();
  readonly accounts = new Map<string, AccountSnapshot>();

  private guard() {
    if (this.rpcDown) throw new Error("fetch failed: RPC unavailable");
  }

  async getLatestBlockhash() {
    this.guard();
    return { blockhash: this.fixedBlockhash ?? randomAddress(), lastValidBlockHeight: this.confirmedHeight + 150n };
  }

  async getBlockHeight(commitment: Commitment) {
    this.guard();
    return commitment === "finalized" ? this.finalizedHeight : this.confirmedHeight;
  }

  async sendTransaction(wire: string) {
    this.guard();
    if (this.sendFailure) throw this.sendFailure;
    this.sent.push(wire);
    return transactionSignature(decodeWireTransaction(wire));
  }

  async getSignatureStatuses(signatures: string[]) {
    this.guard();
    return signatures.map((s) => this.statuses.get(s) ?? null);
  }

  async getTransaction(signature: string) {
    this.guard();
    const status = this.statuses.get(signature);
    return status?.confirmationStatus === "finalized" ? (this.transactions.get(signature) ?? null) : null;
  }

  async getSignaturesForAddress(address: string, options: { until?: string; before?: string; limit: number }) {
    this.guard();
    const all = (this.history.get(address) ?? []).filter(
      (info) => this.statuses.get(info.signature)?.confirmationStatus === "finalized",
    );
    let list = all;
    if (options.before) list = list.slice(list.findIndex((i) => i.signature === options.before) + 1);
    if (options.until) {
      // Like a real node, an `until` signature that is no longer in its ledger is an error.
      if (!this.transactions.has(options.until)) throw new Error(`Transaction ${options.until} not found`);
      const stop = list.findIndex((i) => i.signature === options.until);
      if (stop >= 0) list = list.slice(0, stop);
    }
    return list.slice(0, options.limit);
  }

  async getAccounts(addresses: string[]) {
    this.guard();
    return addresses.map((a) => this.accounts.get(a) ?? null);
  }

  setAccount(address: string, data: Uint8Array) {
    this.accounts.set(address, { owner: "forge", lamports: 1n, data });
  }

  /**
   * Makes a signed (or wallet-broadcast) transaction land. Forge instructions are decoded from
   * the bytes; token balance changes and error are supplied by the test.
   */
  async land(
    wire: string,
    options: {
      err?: unknown;
      commitment?: Commitment;
      tokenBalances?: TokenBalanceChange[];
      watch?: string[];
    } = {},
  ): Promise<string> {
    const transaction = decodeWireTransaction(wire);
    const signature = transactionSignature(transaction);
    const inspected = inspectTransaction(transaction);
    this.slot += 1n;
    this.statuses.set(signature, {
      slot: this.slot,
      err: options.err ?? null,
      confirmationStatus: options.commitment ?? "finalized",
    });
    this.transactions.set(signature, {
      signature,
      slot: this.slot,
      blockTime: 1_900_000_000n,
      err: options.err ?? null,
      feePayer: inspected.feePayer,
      blockhash: inspected.blockhash,
      messageHash: await messageHash(transaction),
      instructions: inspected.instructions.map((ix, index) => ({
        programAddress: ix.programAddress,
        accounts: ix.accounts,
        data: ix.intent
          ? new Uint8Array(buildForgeInstruction(ix.intent).data!)
          : new TextEncoder().encode(ix.memo ?? ""),
        index,
        innerIndex: -1,
      })),
      tokenBalances: options.tokenBalances ?? [],
      logs: [],
    });
    const watched = new Set([...inspected.instructions.flatMap((ix) => ix.accounts), ...(options.watch ?? [])]);
    for (const address of watched) {
      this.history.set(address, [{ signature, slot: this.slot, err: options.err ?? null }, ...(this.history.get(address) ?? [])]);
    }
    return signature;
  }

  /** A transaction with no Forge instruction (e.g. a plain SPL transfer into a vault). */
  landRaw(input: { signature: string; feePayer: string; tokenBalances: TokenBalanceChange[] }) {
    this.slot += 1n;
    this.statuses.set(input.signature, { slot: this.slot, err: null, confirmationStatus: "finalized" });
    this.transactions.set(input.signature, {
      signature: input.signature,
      slot: this.slot,
      blockTime: 1_900_000_000n,
      err: null,
      feePayer: input.feePayer,
      blockhash: randomAddress(),
      messageHash: input.signature,
      instructions: [],
      tokenBalances: input.tokenBalances,
      logs: [],
    });
    for (const b of input.tokenBalances) {
      this.history.set(b.account, [
        { signature: input.signature, slot: this.slot, err: null },
        ...(this.history.get(b.account) ?? []),
      ]);
    }
  }

  /** Drops transactions from the node's ledger, as a pruning RPC node would. */
  prune(signatures: string[]) {
    for (const signature of signatures) {
      this.transactions.delete(signature);
      this.statuses.delete(signature);
      for (const [address, list] of this.history) {
        this.history.set(address, list.filter((i) => i.signature !== signature));
      }
    }
  }

  setCommitment(signature: string, commitment: Commitment) {
    const status = this.statuses.get(signature);
    if (status) this.statuses.set(signature, { ...status, confirmationStatus: commitment });
  }

  /** Moves both heights past every blockhash issued so far. */
  expireAll() {
    this.confirmedHeight += 1_000n;
    this.finalizedHeight = this.confirmedHeight - 32n;
  }
}

export function forgeIntentOf(wire: string): ForgeIntent {
  const intent = inspectTransaction(decodeWireTransaction(wire)).instructions[0]?.intent;
  if (!intent) throw new Error("not a Forge transaction");
  return intent;
}
