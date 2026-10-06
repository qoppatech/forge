import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from "@solana/kit";
import type {
  Address,
  Blockhash,
  Instruction,
  SignatureBytes,
  Transaction,
} from "@solana/kit";

import { base64ToBytes, bytesEqual, sha256Hex } from "./bytes.js";
import { FORGE_PROGRAM_ADDRESS } from "./idl.js";
import {
  buildForgeInstruction,
  decodeForgeInstruction,
  requiredSigners,
} from "./intents.js";
import type { ForgeIntent } from "./intents.js";
import { intentsEqual } from "./json.js";

/** SPL Memo v2. Plans carry `forge:op:<operationId>:<attemptNo>` so every attempt's message is
 *  unique (identical messages share one transaction id) and traceable to its operation. */
export const MEMO_PROGRAM_ADDRESS = address(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

export function operationMemo(operationId: string, attemptNo: number): string {
  return `forge:op:${operationId}:${attemptNo}`;
}

export function parseOperationMemo(
  memo: string
): { operationId: string; attemptNo: number } | undefined {
  const groups =
    /^forge:op:(?<operationId>[0-9a-f-]{36}):(?<attemptNo>\d+)$/u.exec(
      memo
    )?.groups;
  if (groups?.operationId === undefined || groups.attemptNo === undefined) {
    return undefined;
  }
  return {
    attemptNo: Number(groups.attemptNo),
    operationId: groups.operationId,
  };
}

export interface BlockhashLifetime {
  blockhash: string;
  lastValidBlockHeight: bigint;
}

/**
 * A reviewable transaction plan. The API returns it; each signer verifies it with
 * {@link verifyPlan} before signing locally, then submits the signed bytes back.
 */
export interface TransactionPlan {
  intent: ForgeIntent;
  /** Facts read from chain for the signer's review (amounts, payoff); never encoded. */
  display: Record<string, string>;
  requiredSigners: string[];
  feePayer: string;
  programId: string;
  network: string;
  /** Unsigned wire transaction (empty signature slots), base64. */
  transaction: string;
  messageHash: string;
  /** Operation reference memo preceding the Forge instruction, if any. */
  memo: string | null;
  blockhash: string;
  lastValidBlockHeight: string;
}

/**
 * Compiles the v0 transaction for an intent: an optional operation memo followed by exactly
 * one Forge instruction. Fee payer = first required signer.
 */
export function compileIntentTransaction(
  intent: ForgeIntent,
  lifetime: BlockhashLifetime,
  options: { memo?: string } = {}
): Transaction {
  const signers = requiredSigners(intent);
  const [feePayer] = signers;
  if (!feePayer) {
    throw new Error("Intent has no signer");
  }
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: lifetime.blockhash as Blockhash,
          lastValidBlockHeight: lifetime.lastValidBlockHeight,
        },
        m
      ),
    (m) =>
      options.memo
        ? appendTransactionMessageInstruction(
            {
              data: new TextEncoder().encode(options.memo),
              programAddress: MEMO_PROGRAM_ADDRESS,
            },
            m
          )
        : m,
    (m) => appendTransactionMessageInstruction(buildForgeInstruction(intent), m)
  );
  return compileTransaction(message);
}

export function encodeWireTransaction(transaction: Transaction): string {
  return getBase64EncodedWireTransaction(transaction);
}

export function decodeWireTransaction(base64: string): Transaction {
  return getTransactionDecoder().decode(base64ToBytes(base64));
}

export function messageHash(transaction: Transaction): Promise<string> {
  return sha256Hex(new Uint8Array(transaction.messageBytes));
}

export interface InspectedTransaction {
  feePayer: string;
  blockhash: string;
  signers: string[];
  instructions: {
    programAddress: string;
    accounts: string[];
    intent?: ForgeIntent;
    memo?: string;
  }[];
}

/** Decodes a transaction's message into instructions and Forge intents. */
export function inspectTransaction(
  transaction: Transaction
): InspectedTransaction {
  const compiled = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes
  );
  const message = decompileTransactionMessage(compiled);
  const blockhash =
    "blockhash" in message.lifetimeConstraint
      ? message.lifetimeConstraint.blockhash
      : "";
  return {
    blockhash,
    feePayer: message.feePayer.address,
    instructions: (message.instructions as readonly Instruction[]).map(
      (ix) => ({
        accounts: (ix.accounts ?? []).map((a) => a.address),
        intent:
          ix.programAddress === FORGE_PROGRAM_ADDRESS
            ? decodeForgeInstruction({
                accounts: ix.accounts ?? [],
                data: new Uint8Array(ix.data ?? []),
                programAddress: ix.programAddress,
              })
            : undefined,
        memo:
          ix.programAddress === MEMO_PROGRAM_ADDRESS
            ? new TextDecoder().decode(new Uint8Array(ix.data ?? []))
            : undefined,
        programAddress: ix.programAddress,
      })
    ),
    signers: Object.keys(transaction.signatures),
  };
}

/**
 * Signer-side review: the plan's transaction must contain exactly the Forge instruction the
 * intent describes, paid for by the first required signer. Returns a list of problems; an
 * empty list means the bytes match the intent the signer agreed to.
 */
export async function verifyPlan(
  plan: Pick<
    TransactionPlan,
    "intent" | "transaction" | "messageHash" | "requiredSigners"
  > & {
    memo?: string | null;
  },
  expectedIntent: ForgeIntent = plan.intent
): Promise<string[]> {
  const problems: string[] = [];
  let transaction: Transaction;
  let inspected: InspectedTransaction;
  try {
    transaction = decodeWireTransaction(plan.transaction);
    inspected = inspectTransaction(transaction);
  } catch (error) {
    return [`Transaction does not decode: ${(error as Error).message}`];
  }
  const instructions = [...inspected.instructions];
  if (plan.memo) {
    const memo = instructions.shift();
    if (
      memo?.programAddress !== MEMO_PROGRAM_ADDRESS ||
      memo.memo !== plan.memo
    ) {
      problems.push("Operation memo is missing or differs from the plan");
    }
  }
  if (instructions.length !== 1) {
    problems.push(`Expected 1 instruction, found ${instructions.length}`);
  }
  const [only] = instructions;
  if (only?.programAddress !== FORGE_PROGRAM_ADDRESS) {
    problems.push(`Instruction targets ${only?.programAddress}, not Forge`);
  }
  if (!only?.intent || !intentsEqual(only.intent, expectedIntent)) {
    problems.push("Encoded instruction does not match the intent");
  }
  if (!intentsEqual(plan.intent, expectedIntent)) {
    problems.push("Plan intent differs from the requested intent");
  }
  const signers = requiredSigners(expectedIntent);
  if (inspected.feePayer !== signers[0]) {
    problems.push("Unexpected fee payer");
  }
  if (!intentsEqual(inspected.signers.toSorted(), signers.toSorted())) {
    problems.push("Signer set differs from the intent's required signers");
  }
  if ((await messageHash(transaction)) !== plan.messageHash) {
    problems.push("Message hash mismatch");
  }
  return problems;
}

/** Signs locally with the given key pairs; other signature slots are preserved. */
export async function signPlanTransaction(
  base64: string,
  keyPairs: CryptoKeyPair[]
): Promise<string> {
  const signed = await partiallySignTransaction(
    keyPairs,
    decodeWireTransaction(base64)
  );
  return encodeWireTransaction(signed);
}

export interface SignatureCheck {
  signer: string;
  status: "valid" | "missing" | "invalid";
}

export async function checkSignatures(
  transaction: Transaction
): Promise<SignatureCheck[]> {
  return await Promise.all(
    Object.entries(transaction.signatures).map(
      async ([signer, signature]): Promise<SignatureCheck> => {
        if (!signature) {
          return { signer, status: "missing" };
        }
        const key = await getPublicKeyFromAddress(signer as Address);
        const valid = await verifySignature(
          key,
          signature,
          transaction.messageBytes
        );
        return { signer, status: valid ? "valid" : "invalid" };
      }
    )
  );
}

/**
 * Merges signatures from a submitted transaction into the stored unsigned one. Rejects any
 * change to the message bytes and any signature that does not verify.
 */
export async function mergeSignatures(
  stored: Transaction,
  submitted: Transaction
): Promise<{ transaction: Transaction; added: string[] }> {
  if (
    !bytesEqual(
      new Uint8Array(stored.messageBytes),
      new Uint8Array(submitted.messageBytes)
    )
  ) {
    throw new Error("Submitted message differs from the prepared message");
  }
  const checks = await checkSignatures(submitted);
  const invalid = checks.filter((c) => c.status === "invalid");
  if (invalid.length > 0) {
    throw new Error(
      `Invalid signature from ${invalid.map((c) => c.signer).join(", ")}`
    );
  }
  const signatures: Record<string, SignatureBytes | null> = {
    ...stored.signatures,
  };
  const added: string[] = [];
  for (const check of checks) {
    if (check.status !== "valid") {
      continue;
    }
    if (!(check.signer in signatures)) {
      throw new Error(`Unexpected signer ${check.signer}`);
    }
    if (!signatures[check.signer]) {
      added.push(check.signer);
    }
    signatures[check.signer] =
      submitted.signatures[check.signer as Address] ?? null;
  }
  return { added, transaction: { ...stored, signatures } as Transaction };
}

export function isFullySigned(transaction: Transaction): boolean {
  return Object.values(transaction.signatures).every((s) => s !== null);
}

/** The transaction id: the fee payer's signature, base58. */
export function transactionSignature(transaction: Transaction): string {
  return getSignatureFromTransaction(transaction);
}
