import { decodeWithDiscriminator, type BorshValue } from "./codec.js";
import { idlAccountDiscriminator, idlTypeDef, type IdlField } from "./idl.js";

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

const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function normalize(value: BorshValue): unknown {
  if (value instanceof Uint8Array) {
    return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (Array.isArray(value)) return value.map(normalize);
  return typeof value === "object" && value !== null ? decodeObject(value) : value;
}

function decodeObject(values: { [key: string]: BorshValue }): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [camel(k), normalize(v)]));
}

function decode<T>(name: string, data: Uint8Array): T | undefined {
  const def = idlTypeDef(name);
  if (def.type.kind !== "struct") throw new Error(`${name} is not a struct`);
  const fields: IdlField[] = def.type.fields;
  // Accounts may carry trailing allocation; only the declared fields are read.
  const values = decodeWithDiscriminator(idlAccountDiscriminator(name), fields, data, {
    exact: false,
  });
  if (!values) return undefined;
  return decodeObject(values) as T;
}

function required<T>(name: string, data: Uint8Array): T {
  const value = decode<T>(name, data);
  if (!value) throw new Error(`Account data is not a Forge ${name}`);
  return value;
}

export const decodeVaultAccount = (data: Uint8Array) => required<VaultAccount>("Vault", data);
export const decodeLoanAccount = (data: Uint8Array) => required<LoanAccount>("Loan", data);
export const decodeWithdrawalAccount = (data: Uint8Array) =>
  required<WithdrawalAccount>("Withdrawal", data);

/** Identifies and decodes any Forge-owned account by its discriminator. */
export function decodeForgeAccount(data: Uint8Array): ForgeAccount | undefined {
  for (const type of ["Vault", "Loan", "Withdrawal"] as const) {
    const decoded = decode<never>(type, data);
    if (decoded) return { type, data: decoded } as ForgeAccount;
  }
  return undefined;
}
