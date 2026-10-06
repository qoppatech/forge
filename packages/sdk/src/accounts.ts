import { hexToBytes } from "./bytes.js";
import { decodeWithDiscriminator, encodeWithDiscriminator } from "./codec.js";
import type { BorshValue } from "./codec.js";
import { idlAccountDiscriminator, idlTypeDef } from "./idl.js";
import type { IdlField } from "./idl.js";

export interface VaultAccount {
  treasury: string;
  vaultId: string;
  mint: string;
  tokenAccount: string;
  approvers: [string, string];
  treasuryDestination: string;
  perLoanLimit: bigint;
  outstandingLimit: bigint;
  outstandingPrincipal: bigint;
  disbursementPaused: boolean;
  pauseSeq: bigint;
  bump: number;
}

export type LoanState = "Proposed" | "Approved" | "Active" | "Repaid";

export interface LoanAccount {
  vault: string;
  loanId: string;
  borrower: string;
  destination: string;
  principal: bigint;
  termRateBps: number;
  fixedInterest: bigint;
  fixedPayoff: bigint;
  termSeconds: bigint;
  offerExpiry: bigint;
  approvals: [boolean, boolean];
  state: LoanState;
  proposedAt: bigint;
  disbursedAt: bigint;
  repaidAt: bigint;
  bump: number;
}

export type WithdrawalState = "Proposed" | "Executed";

export interface WithdrawalAccount {
  vault: string;
  withdrawalId: string;
  amount: bigint;
  approvals: [boolean, boolean];
  state: WithdrawalState;
  proposedAt: bigint;
  executedAt: bigint;
  bump: number;
}

export type ForgeAccount =
  | { type: "Vault"; data: VaultAccount }
  | { type: "Loan"; data: LoanAccount }
  | { type: "Withdrawal"; data: WithdrawalAccount };

const camel = (name: string) =>
  name.replaceAll(/_(?<letter>[a-z])/gu, (_, c: string) => c.toUpperCase());

function normalize(value: BorshValue): unknown {
  if (value instanceof Uint8Array) {
    return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [camel(k), normalize(v)])
    );
  }
  return value;
}

function decode<T>(name: string, data: Uint8Array): T | undefined {
  const def = idlTypeDef(name);
  if (def.type.kind !== "struct") {
    throw new Error(`${name} is not a struct`);
  }
  const fields: IdlField[] = def.type.fields;
  // Accounts may carry trailing allocation; only the declared fields are read.
  const values = decodeWithDiscriminator(
    idlAccountDiscriminator(name),
    fields,
    data,
    {
      exact: false,
    }
  );
  if (!values) {
    return undefined;
  }
  return normalize(values) as T;
}

function required<T>(name: string, data: Uint8Array): T {
  const value = decode<T>(name, data);
  if (!value) {
    throw new Error(`Account data is not a Forge ${name}`);
  }
  return value;
}

export const decodeVaultAccount = (data: Uint8Array) =>
  required<VaultAccount>("Vault", data);
export const decodeLoanAccount = (data: Uint8Array) =>
  required<LoanAccount>("Loan", data);
export const decodeWithdrawalAccount = (data: Uint8Array) =>
  required<WithdrawalAccount>("Withdrawal", data);

/** Identifies and decodes any Forge-owned account by its discriminator. */
export function decodeForgeAccount(data: Uint8Array): ForgeAccount | undefined {
  for (const type of ["Vault", "Loan", "Withdrawal"] as const) {
    const decoded = decode<never>(type, data);
    if (decoded) {
      return { data: decoded, type } as ForgeAccount;
    }
  }
  return undefined;
}

/**
 * Encodes a Forge account in its on-chain layout (discriminator + Borsh fields). Used for
 * fixtures and simulations; the inverse of the decoders above.
 */
export function encodeForgeAccount(
  type: "Vault" | "Loan" | "Withdrawal",
  value: VaultAccount | LoanAccount | WithdrawalAccount
): Uint8Array {
  const def = idlTypeDef(type);
  if (def.type.kind !== "struct") {
    throw new Error(`${type} is not a struct`);
  }
  const source = value as unknown as Record<string, unknown>;
  const fields: Record<string, BorshValue> = {};
  for (const field of def.type.fields) {
    const raw = source[camel(field.name)];
    const isBytes =
      typeof field.type === "object" &&
      "array" in field.type &&
      field.type.array[0] === "u8";
    fields[field.name] = (
      isBytes ? hexToBytes(String(raw), 32) : raw
    ) as BorshValue;
  }
  return encodeWithDiscriminator(
    idlAccountDiscriminator(type),
    def.type.fields,
    fields
  );
}
