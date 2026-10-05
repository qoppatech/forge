import { idl } from "./idl.js";
import { INIT_KINDS, type IntentKind } from "./intents.js";

/**
 * How an orchestrator should treat a failed Forge transaction:
 * - `replay`: the instruction may already have been applied (init PDA exists, approval or state
 *   transition already happened) — verify on-chain state before calling it a failure.
 * - `rejected`: a business rule or stale input rejected the request; never retry blindly.
 * - `unauthorized` / `invalid_accounts`: the transaction was malformed or tampered with.
 * - `token`: the SPL Token program rejected the transfer (for example insufficient funds).
 * - `transaction`: the runtime rejected the transaction before the program ran.
 */
export type ErrorCategory =
  | "replay"
  | "rejected"
  | "unauthorized"
  | "invalid_accounts"
  | "token"
  | "transaction"
  | "unknown";

export interface DecodedTransactionError {
  instructionIndex?: number;
  code?: number;
  name: string;
  message: string;
  category: ErrorCategory;
}

const REPLAY = new Set(["AlreadyApproved", "InvalidLoanState", "InvalidWithdrawalState"]);
const UNAUTHORIZED = new Set(["UnauthorizedApprover", "InvalidBorrower", "InvalidDestination"]);

const ANCHOR_ERRORS: Record<number, string> = {
  2000: "ConstraintMut",
  2001: "ConstraintHasOne",
  2003: "ConstraintRaw",
  2006: "ConstraintSeeds",
  2012: "ConstraintAddress",
  2014: "ConstraintTokenMint",
  2015: "ConstraintTokenOwner",
  3001: "AccountDiscriminatorNotFound",
  3002: "AccountDiscriminatorMismatch",
  3007: "AccountOwnedByWrongProgram",
  3008: "InvalidProgramId",
  3010: "AccountNotSigner",
  3012: "AccountNotInitialized",
};

const TOKEN_ERRORS: Record<number, string> = {
  0: "NotRentExempt",
  1: "InsufficientFunds",
  2: "InvalidMint",
  3: "MintMismatch",
  4: "OwnerMismatch",
  17: "AccountFrozen",
};

export const FORGE_ERRORS = idl.errors;

export function forgeErrorByCode(code: number) {
  return FORGE_ERRORS.find((error) => error.code === code);
}

function customCode(value: unknown): number | undefined {
  if (value && typeof value === "object" && "Custom" in value) {
    return Number((value as { Custom: number | bigint }).Custom);
  }
  return undefined;
}

/**
 * Decodes a transaction error as returned by `getSignatureStatuses`/`getTransaction`.
 * `kinds[i]` is the Forge intent kind at top-level instruction `i`, used to attribute
 * low custom codes raised by CPI callees (System `AccountAlreadyInUse`, SPL Token errors).
 */
export function decodeTransactionError(
  err: unknown,
  kinds: readonly (IntentKind | undefined)[] = [],
): DecodedTransactionError {
  if (typeof err === "string") {
    return { name: err, message: err, category: "transaction" };
  }
  if (err && typeof err === "object" && "InstructionError" in err) {
    const [rawIndex, detail] = (err as { InstructionError: [number | bigint, unknown] })
      .InstructionError;
    const instructionIndex = Number(rawIndex);
    const kind = kinds[instructionIndex];
    const code = customCode(detail);
    if (code === undefined) {
      const name = typeof detail === "string" ? detail : JSON.stringify(detail);
      return { instructionIndex, name, message: name, category: "invalid_accounts" };
    }
    if (code >= 6000) {
      const forge = forgeErrorByCode(code);
      const name = forge?.name ?? `ForgeError(${code})`;
      const category: ErrorCategory = REPLAY.has(name)
        ? "replay"
        : UNAUTHORIZED.has(name)
          ? "unauthorized"
          : forge
            ? "rejected"
            : "unknown";
      return { instructionIndex, code, name, message: forge?.msg ?? name, category };
    }
    if (code >= 100) {
      const name = ANCHOR_ERRORS[code] ?? `AnchorError(${code})`;
      return { instructionIndex, code, name, message: name, category: "invalid_accounts" };
    }
    if (code === 0 && kind && INIT_KINDS.has(kind)) {
      return {
        instructionIndex,
        code,
        name: "AccountAlreadyInUse",
        message: "The PDA already exists (System Program)",
        category: "replay",
      };
    }
    const name = TOKEN_ERRORS[code] ?? `CustomError(${code})`;
    return { instructionIndex, code, name, message: name, category: "token" };
  }
  return { name: "Unknown", message: JSON.stringify(err), category: "unknown" };
}
