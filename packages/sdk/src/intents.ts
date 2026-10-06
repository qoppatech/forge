import { AccountRole, address } from "@solana/kit";
import type { AccountMeta, Address, Instruction } from "@solana/kit";

import { bytesToHex, hexToBytes } from "./bytes.js";
import { decodeWithDiscriminator, encodeWithDiscriminator } from "./codec.js";
import type { BorshValue } from "./codec.js";
import { FORGE_PROGRAM_ADDRESS, idlInstruction } from "./idl.js";

/**
 * JSON-safe description of exactly what one Forge instruction encodes. Amounts and i64 values
 * are decimal strings, identifiers are 32-byte hex strings and keys are base58 addresses, so an
 * intent can be stored, hashed and compared without loss.
 */
export interface CreateVaultIntent {
  kind: "create_vault";
  treasury: string;
  vault: string;
  vaultId: string;
  mint: string;
  vaultTokenAccount: string;
  treasuryDestination: string;
  approvers: [string, string];
  perLoanLimit: string;
  outstandingLimit: string;
}

export interface FundVaultIntent {
  kind: "fund_vault";
  treasury: string;
  vault: string;
  mint: string;
  source: string;
  vaultTokenAccount: string;
  amount: string;
}

export interface ProposeLoanIntent {
  kind: "propose_loan";
  approver: string;
  vault: string;
  loan: string;
  loanId: string;
  borrower: string;
  destination: string;
  mint: string;
  principal: string;
  termRateBps: number;
  termSeconds: string;
  offerExpiry: string;
}

export interface ApproveLoanIntent {
  kind: "approve_loan";
  approver: string;
  vault: string;
  loan: string;
}

export interface DrawLoanIntent {
  kind: "draw_loan";
  borrower: string;
  vault: string;
  loan: string;
  mint: string;
  vaultTokenAccount: string;
  destination: string;
}

export interface RepayLoanIntent {
  kind: "repay_loan";
  borrower: string;
  vault: string;
  loan: string;
  mint: string;
  borrowerTokens: string;
  vaultTokenAccount: string;
}

export interface ProposeWithdrawalIntent {
  kind: "propose_withdrawal";
  approver: string;
  vault: string;
  withdrawal: string;
  withdrawalId: string;
  amount: string;
}

export interface ApproveWithdrawalIntent {
  kind: "approve_withdrawal";
  approver: string;
  vault: string;
  withdrawal: string;
  mint: string;
  vaultTokenAccount: string;
  treasuryDestination: string;
}

export interface SetDisbursementPausedIntent {
  kind: "set_disbursement_paused";
  approverA: string;
  approverB: string;
  vault: string;
  paused: boolean;
  expectedSeq: string;
}

export type ForgeIntent =
  | CreateVaultIntent
  | FundVaultIntent
  | ProposeLoanIntent
  | ApproveLoanIntent
  | DrawLoanIntent
  | RepayLoanIntent
  | ProposeWithdrawalIntent
  | ApproveWithdrawalIntent
  | SetDisbursementPausedIntent;

export type IntentKind = ForgeIntent["kind"];

type ArgConversion = "u64" | "i64" | "u16" | "bool" | "bytes32" | "pubkeys";

interface KindSpec {
  /** IDL account name → intent field. Accounts with a fixed IDL address are filled in. */
  accounts: Record<string, string>;
  /** IDL argument name → [intent field, conversion]. */
  args: Record<string, [string, ArgConversion]>;
  /** Intent fields holding the required signers, fee payer first. */
  signers: string[];
  /** Intent field naming the account the operation acts on. */
  subject: string;
}

/** Mapping between intents and IDL instructions. `sdk.test.ts` fails if it drifts from the IDL. */
export const INTENT_SPECS: Record<IntentKind, KindSpec> = {
  approve_loan: {
    accounts: { approver: "approver", loan: "loan", vault: "vault" },
    args: {},
    signers: ["approver"],
    subject: "loan",
  },
  approve_withdrawal: {
    accounts: {
      approver: "approver",
      mint: "mint",
      treasury_destination: "treasuryDestination",
      vault: "vault",
      vault_token_account: "vaultTokenAccount",
      withdrawal: "withdrawal",
    },
    args: {},
    signers: ["approver"],
    subject: "withdrawal",
  },
  create_vault: {
    accounts: {
      mint: "mint",
      treasury: "treasury",
      treasury_destination: "treasuryDestination",
      vault: "vault",
      vault_token_account: "vaultTokenAccount",
    },
    args: {
      approvers: ["approvers", "pubkeys"],
      outstanding_limit: ["outstandingLimit", "u64"],
      per_loan_limit: ["perLoanLimit", "u64"],
      vault_id: ["vaultId", "bytes32"],
    },
    signers: ["treasury"],
    subject: "vault",
  },
  draw_loan: {
    accounts: {
      borrower: "borrower",
      destination: "destination",
      loan: "loan",
      mint: "mint",
      vault: "vault",
      vault_token_account: "vaultTokenAccount",
    },
    args: {},
    signers: ["borrower"],
    subject: "loan",
  },
  fund_vault: {
    accounts: {
      mint: "mint",
      source: "source",
      treasury: "treasury",
      vault: "vault",
      vault_token_account: "vaultTokenAccount",
    },
    args: { amount: ["amount", "u64"] },
    signers: ["treasury"],
    subject: "vault",
  },
  propose_loan: {
    accounts: {
      approver: "approver",
      borrower: "borrower",
      destination: "destination",
      loan: "loan",
      mint: "mint",
      vault: "vault",
    },
    args: {
      loan_id: ["loanId", "bytes32"],
      offer_expiry: ["offerExpiry", "i64"],
      principal: ["principal", "u64"],
      term_rate_bps: ["termRateBps", "u16"],
      term_seconds: ["termSeconds", "i64"],
    },
    signers: ["approver"],
    subject: "loan",
  },
  propose_withdrawal: {
    accounts: {
      approver: "approver",
      vault: "vault",
      withdrawal: "withdrawal",
    },
    args: {
      amount: ["amount", "u64"],
      withdrawal_id: ["withdrawalId", "bytes32"],
    },
    signers: ["approver"],
    subject: "withdrawal",
  },
  repay_loan: {
    accounts: {
      borrower: "borrower",
      borrower_tokens: "borrowerTokens",
      loan: "loan",
      mint: "mint",
      vault: "vault",
      vault_token_account: "vaultTokenAccount",
    },
    args: {},
    signers: ["borrower"],
    subject: "loan",
  },
  set_disbursement_paused: {
    accounts: {
      approver_a: "approverA",
      approver_b: "approverB",
      vault: "vault",
    },
    args: {
      expected_seq: ["expectedSeq", "u64"],
      paused: ["paused", "bool"],
    },
    signers: ["approverA", "approverB"],
    subject: "vault",
  },
};

export const INTENT_KINDS = Object.keys(INTENT_SPECS) as IntentKind[];

/** Kinds whose instruction creates a PDA with `init`; a replay fails with System `Custom(0)`. */
export const INIT_KINDS: ReadonlySet<IntentKind> = new Set([
  "create_vault",
  "propose_loan",
  "propose_withdrawal",
]);

function field(intent: ForgeIntent, name: string): unknown {
  return (intent as unknown as Record<string, unknown>)[name];
}

function toBorsh(
  value: unknown,
  conversion: ArgConversion,
  name: string
): BorshValue {
  // oxlint-disable-next-line default-case -- exhaustive over ArgConversion; TS enforces it and a default would change the result for unknown conversions
  switch (conversion) {
    case "u64":
    case "i64": {
      if (typeof value !== "string" || !/^-?\d+$/u.test(value)) {
        throw new TypeError(`${name} must be an integer decimal string`);
      }
      return BigInt(value);
    }
    case "u16": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new TypeError(`${name} must be an integer`);
      }
      return value;
    }
    case "bool": {
      if (typeof value !== "boolean") {
        throw new TypeError(`${name} must be a boolean`);
      }
      return value;
    }
    case "bytes32": {
      if (typeof value !== "string") {
        throw new TypeError(`${name} must be 32-byte hex`);
      }
      return hexToBytes(value, 32);
    }
    case "pubkeys": {
      if (!Array.isArray(value)) {
        throw new TypeError(`${name} must be an address list`);
      }
      return value.map((item) => address(String(item)));
    }
  }
}

function fromBorsh(value: BorshValue, conversion: ArgConversion): unknown {
  // oxlint-disable-next-line default-case -- exhaustive over ArgConversion; a default would change the result for unknown conversions
  switch (conversion) {
    case "u64":
    case "i64": {
      return String(value);
    }
    case "u16":
    case "bool": {
      return value;
    }
    case "bytes32": {
      return bytesToHex(value as Uint8Array);
    }
    case "pubkeys": {
      return (value as BorshValue[]).map(String);
    }
  }
}

/** Required signers for an intent, fee payer first. */
export function requiredSigners(intent: ForgeIntent): string[] {
  return INTENT_SPECS[intent.kind].signers.map((name) =>
    String(field(intent, name))
  );
}

/** The account the operation acts on (vault, loan or withdrawal). */
export function intentSubject(intent: ForgeIntent): string {
  return String(field(intent, INTENT_SPECS[intent.kind].subject));
}

function accountRole(account: {
  signer?: boolean;
  writable?: boolean;
}): AccountRole {
  if (account.signer) {
    return account.writable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER;
  }
  return account.writable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

/** Builds the Forge instruction for an intent with IDL-ordered accounts and IDL roles. */
export function buildForgeInstruction(intent: ForgeIntent): Instruction {
  const spec = INTENT_SPECS[intent.kind];
  const ix = idlInstruction(intent.kind);
  const accounts: AccountMeta[] = ix.accounts.map((account) => {
    const fieldName = spec.accounts[account.name];
    const value =
      account.address ?? (fieldName ? field(intent, fieldName) : undefined);
    if (typeof value !== "string") {
      throw new TypeError(`${intent.kind}: missing account ${account.name}`);
    }
    return { address: address(value), role: accountRole(account) };
  });
  const args: Record<string, BorshValue> = {};
  for (const arg of ix.args) {
    const mapping = spec.args[arg.name];
    if (!mapping) {
      throw new Error(`${intent.kind}: no mapping for argument ${arg.name}`);
    }
    const [fieldName, conversion] = mapping;
    args[arg.name] = toBorsh(field(intent, fieldName), conversion, fieldName);
  }
  return {
    accounts,
    data: encodeWithDiscriminator(ix.discriminator, ix.args, args),
    programAddress: FORGE_PROGRAM_ADDRESS,
  };
}

export interface RawInstruction {
  programAddress: Address | string;
  accounts: readonly { address: Address | string }[];
  data: Uint8Array;
}

/**
 * Decodes a Forge instruction back into its intent. Returns undefined for other programs and
 * throws for Forge data that matches no IDL instruction or uses a non-canonical fixed account.
 */
export function decodeForgeInstruction(
  instruction: RawInstruction
): ForgeIntent | undefined {
  if (instruction.programAddress !== FORGE_PROGRAM_ADDRESS) {
    return undefined;
  }
  for (const kind of INTENT_KINDS) {
    const ix = idlInstruction(kind);
    const args = decodeWithDiscriminator(
      ix.discriminator,
      ix.args,
      instruction.data,
      {
        exact: true,
      }
    );
    if (!args) {
      continue;
    }
    if (instruction.accounts.length < ix.accounts.length) {
      throw new Error(`${kind}: expected ${ix.accounts.length} accounts`);
    }
    const spec = INTENT_SPECS[kind];
    const intent: Record<string, unknown> = { kind };
    for (const [index, account] of ix.accounts.entries()) {
      const actual = String(instruction.accounts[index]?.address);
      if (account.address && account.address !== actual) {
        throw new Error(`${kind}: ${account.name} must be ${account.address}`);
      }
      const fieldName = spec.accounts[account.name];
      if (fieldName) {
        intent[fieldName] = actual;
      }
    }
    for (const [argName, [fieldName, conversion]] of Object.entries(
      spec.args
    )) {
      const value = args[argName];
      if (value === undefined) {
        throw new Error(`${kind}: missing argument ${argName}`);
      }
      intent[fieldName] = fromBorsh(value, conversion);
    }
    return intent as unknown as ForgeIntent;
  }
  throw new Error("Unknown Forge instruction discriminator");
}
