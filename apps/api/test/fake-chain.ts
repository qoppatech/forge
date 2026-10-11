import {
  buildForgeInstruction,
  decodeWireTransaction,
  inspectTransaction,
  messageHash,
  transactionSignature,
} from "@forge/sdk";
import type { ForgeIntent } from "@forge/sdk";
import { getAddressDecoder } from "@solana/kit";

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
export const randomAddress = () =>
  addressDecoder.decode(crypto.getRandomValues(new Uint8Array(32)));

/**
 * A programmable ledger for failure-mode tests. Nothing executes: tests decide when a
 * signature lands, at which commitment and with which error, and when blockhashes expire.
 */
export class FakeChain implements Chain {
  readonly network = "test";
  confirmedHeight = 1000n;
  finalizedHeight = 968n;
  slot = 5000n;
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
    if (this.rpcDown) {
      throw new Error("fetch failed: RPC unavailable");
    }
  }

  /** Settles like an RPC call: an outage or lookup failure rejects rather than throws. */
  private respond<T>(produce: () => T): Promise<T> {
    try {
      this.guard();
      return Promise.resolve(produce());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  getLatestBlockhash() {
    return this.respond(() => ({
      blockhash: this.fixedBlockhash ?? randomAddress(),
      lastValidBlockHeight: this.confirmedHeight + 150n,
    }));
  }

  getBlockHeight(commitment: Commitment) {
    return this.respond(() =>
      commitment === "finalized" ? this.finalizedHeight : this.confirmedHeight
    );
  }

  sendTransaction(wire: string) {
    return this.respond(() => {
      if (this.sendFailure) {
        throw this.sendFailure;
      }
      this.sent.push(wire);
      return transactionSignature(decodeWireTransaction(wire));
    });
  }

  getSignatureStatuses(signatures: string[]) {
    return this.respond(() =>
      signatures.map((s) => this.statuses.get(s) ?? null)
    );
  }

  getTransaction(signature: string) {
    return this.respond(() => {
      const status = this.statuses.get(signature);
      return status?.confirmationStatus === "finalized"
        ? (this.transactions.get(signature) ?? null)
        : null;
    });
  }

  getSignaturesForAddress(
    address: string,
    options: { until?: string; before?: string; limit: number }
  ) {
    return this.respond(() => this.signaturesFor(address, options));
  }

  private signaturesFor(
    address: string,
    options: { until?: string; before?: string; limit: number }
  ) {
    const all = (this.history.get(address) ?? []).filter(
      (info) =>
        this.statuses.get(info.signature)?.confirmationStatus === "finalized"
    );
    let list = all;
    if (options.before) {
      list = list.slice(
        list.findIndex((i) => i.signature === options.before) + 1
      );
    }
    if (options.until) {
      // Like a real node, an `until` signature that is no longer in its ledger is an error.
      if (!this.transactions.has(options.until)) {
        throw new Error(`Transaction ${options.until} not found`);
      }
      const stop = list.findIndex((i) => i.signature === options.until);
      if (stop !== -1) {
        list = list.slice(0, stop);
      }
    }
    return list.slice(0, options.limit);
  }

  getAccounts(addresses: string[]) {
    return this.respond(() =>
      addresses.map((a) => this.accounts.get(a) ?? null)
    );
  }

  setAccount(address: string, data: Uint8Array) {
    this.accounts.set(address, { data, lamports: 1n, owner: "forge" });
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
    } = {}
  ): Promise<string> {
    const transaction = decodeWireTransaction(wire);
    const signature = transactionSignature(transaction);
    const inspected = inspectTransaction(transaction);
    this.slot += 1n;
    this.statuses.set(signature, {
      confirmationStatus: options.commitment ?? "finalized",
      err: options.err ?? null,
      slot: this.slot,
    });
    this.transactions.set(signature, {
      blockTime: 1_900_000_000n,
      blockhash: inspected.blockhash,
      err: options.err ?? null,
      feePayer: inspected.feePayer,
      instructions: inspected.instructions.map((ix, index) => ({
        accounts: ix.accounts,
        data: ix.intent
          ? new Uint8Array(buildForgeInstruction(ix.intent).data ?? [])
          : new TextEncoder().encode(ix.memo ?? ""),
        index,
        innerIndex: -1,
        programAddress: ix.programAddress,
      })),
      logs: [],
      messageHash: await messageHash(transaction),
      signature,
      slot: this.slot,
      tokenBalances: options.tokenBalances ?? [],
    });
    const watched = new Set([
      ...inspected.instructions.flatMap((ix) => ix.accounts),
      ...(options.watch ?? []),
    ]);
    for (const address of watched) {
      this.history.set(address, [
        { err: options.err ?? null, signature, slot: this.slot },
        ...(this.history.get(address) ?? []),
      ]);
    }
    return signature;
  }

  /** A transaction with no Forge instruction (e.g. a plain SPL transfer into a vault). */
  landRaw(input: {
    signature: string;
    feePayer: string;
    tokenBalances: TokenBalanceChange[];
  }) {
    this.slot += 1n;
    this.statuses.set(input.signature, {
      confirmationStatus: "finalized",
      err: null,
      slot: this.slot,
    });
    this.transactions.set(input.signature, {
      blockTime: 1_900_000_000n,
      blockhash: randomAddress(),
      err: null,
      feePayer: input.feePayer,
      instructions: [],
      logs: [],
      messageHash: input.signature,
      signature: input.signature,
      slot: this.slot,
      tokenBalances: input.tokenBalances,
    });
    for (const b of input.tokenBalances) {
      this.history.set(b.account, [
        { err: null, signature: input.signature, slot: this.slot },
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
        this.history.set(
          address,
          list.filter((i) => i.signature !== signature)
        );
      }
    }
  }

  setCommitment(signature: string, commitment: Commitment) {
    const status = this.statuses.get(signature);
    if (status) {
      this.statuses.set(signature, {
        ...status,
        confirmationStatus: commitment,
      });
    }
  }

  /** Moves both heights past every blockhash issued so far. */
  expireAll() {
    this.confirmedHeight += 1000n;
    this.finalizedHeight = this.confirmedHeight - 32n;
  }
}

export function forgeIntentOf(wire: string): ForgeIntent {
  const intent = inspectTransaction(decodeWireTransaction(wire)).instructions[0]
    ?.intent;
  if (!intent) {
    throw new Error("not a Forge transaction");
  }
  return intent;
}
