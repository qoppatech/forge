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
  type Address,
  type Blockhash,
  type Instruction,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";

import { base64ToBytes, bytesEqual, sha256Hex } from "./bytes.js";
import { FORGE_PROGRAM_ADDRESS } from "./idl.js";
import {
  buildForgeInstruction,
  decodeForgeInstruction,
  requiredSigners,
  type ForgeIntent,
} from "./intents.js";
import { intentsEqual } from "./json.js";

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
  blockhash: string;
  lastValidBlockHeight: string;
}

/** Compiles the single-instruction v0 transaction for an intent. Fee payer = first signer. */
export function compileIntentTransaction(
  intent: ForgeIntent,
  lifetime: BlockhashLifetime,
): Transaction {
  const signers = requiredSigners(intent);
  const feePayer = signers[0];
  if (!feePayer) throw new Error("Intent has no signer");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: lifetime.blockhash as Blockhash,
          lastValidBlockHeight: lifetime.lastValidBlockHeight,
        },
        m,
      ),
    (m) => appendTransactionMessageInstruction(buildForgeInstruction(intent), m),
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
  instructions: { programAddress: string; accounts: string[]; intent?: ForgeIntent }[];
}

/** Decodes a transaction's message into instructions and Forge intents. */
export function inspectTransaction(transaction: Transaction): InspectedTransaction {
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const message = decompileTransactionMessage(compiled);
  const blockhash =
    "blockhash" in message.lifetimeConstraint ? message.lifetimeConstraint.blockhash : "";
  return {
    feePayer: message.feePayer.address,
    blockhash,
    signers: Object.keys(transaction.signatures),
    instructions: (message.instructions as readonly Instruction[]).map((ix) => ({
      programAddress: ix.programAddress,
      accounts: (ix.accounts ?? []).map((a) => a.address),
      intent:
        ix.programAddress === FORGE_PROGRAM_ADDRESS
          ? decodeForgeInstruction({
              programAddress: ix.programAddress,
              accounts: ix.accounts ?? [],
              data: new Uint8Array(ix.data ?? []),
            })
          : undefined,
    })),
  };
}

/**
 * Signer-side review: the plan's transaction must contain exactly the Forge instruction the
 * intent describes, paid for by the first required signer. Returns a list of problems; an
 * empty list means the bytes match the intent the signer agreed to.
 */
export async function verifyPlan(
  plan: Pick<TransactionPlan, "intent" | "transaction" | "messageHash" | "requiredSigners">,
  expectedIntent: ForgeIntent = plan.intent,
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
  if (inspected.instructions.length !== 1) {
    problems.push(`Expected 1 instruction, found ${inspected.instructions.length}`);
  }
  const [only] = inspected.instructions;
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
  if (inspected.feePayer !== signers[0]) problems.push("Unexpected fee payer");
  if (!intentsEqual([...inspected.signers].sort(), [...signers].sort())) {
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
  keyPairs: CryptoKeyPair[],
): Promise<string> {
  const signed = await partiallySignTransaction(keyPairs, decodeWireTransaction(base64));
  return encodeWireTransaction(signed);
}

export type SignatureCheck = { signer: string; status: "valid" | "missing" | "invalid" };

export async function checkSignatures(transaction: Transaction): Promise<SignatureCheck[]> {
  const checks: SignatureCheck[] = [];
  for (const [signer, signature] of Object.entries(transaction.signatures)) {
    if (!signature) {
      checks.push({ signer, status: "missing" });
      continue;
    }
    const key = await getPublicKeyFromAddress(signer as Address);
    const valid = await verifySignature(key, signature, transaction.messageBytes);
    checks.push({ signer, status: valid ? "valid" : "invalid" });
  }
  return checks;
}

/**
 * Merges signatures from a submitted transaction into the stored unsigned one. Rejects any
 * change to the message bytes and any signature that does not verify.
 */
export async function mergeSignatures(
  stored: Transaction,
  submitted: Transaction,
): Promise<{ transaction: Transaction; added: string[] }> {
  if (!bytesEqual(new Uint8Array(stored.messageBytes), new Uint8Array(submitted.messageBytes))) {
    throw new Error("Submitted message differs from the prepared message");
  }
  const checks = await checkSignatures(submitted);
  const invalid = checks.filter((c) => c.status === "invalid");
  if (invalid.length > 0) {
    throw new Error(`Invalid signature from ${invalid.map((c) => c.signer).join(", ")}`);
  }
  const signatures: Record<string, SignatureBytes | null> = { ...stored.signatures };
  const added: string[] = [];
  for (const check of checks) {
    if (check.status !== "valid") continue;
    if (!(check.signer in signatures)) throw new Error(`Unexpected signer ${check.signer}`);
    if (!signatures[check.signer]) added.push(check.signer);
    signatures[check.signer] = submitted.signatures[check.signer as Address] ?? null;
  }
  return { transaction: { ...stored, signatures } as Transaction, added };
}

export function isFullySigned(transaction: Transaction): boolean {
  return Object.values(transaction.signatures).every((s) => s !== null);
}

/** The transaction id: the fee payer's signature, base58. */
export function transactionSignature(transaction: Transaction): string {
  return getSignatureFromTransaction(transaction);
}

