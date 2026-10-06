export type Role = "treasury" | "approverA" | "approverB" | "borrower";

export interface Session {
  rpcUrl: string;
  apiUrl: string;
  apiKey: string;
  wallets: Record<Role | "outsider", { address: string; seed: string }>;
  accounts: {
    mint: string;
    treasurySource: string;
    treasuryDestination: string;
    borrowerTokens: string;
    outsiderTokens: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export async function loadSession(): Promise<Session | null> {
  const response = await fetch("/dev/session");
  return response.ok ? ((await response.json()) as Session) : null;
}

export function createApi(apiKey: string) {
  return async function request<T = unknown>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
    };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = crypto.randomUUID();
    }
    const init: RequestInit = { headers, method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await fetch(path, init);
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      const error = payload.error ?? {};
      throw new ApiError(
        response.status,
        error.code ?? "error",
        error.message ?? response.statusText
      );
    }
    return payload as T;
  };
}

export type Api = ReturnType<typeof createApi>;

export interface Operation {
  id: string;
  kind: string;
  origin: "api" | "chain";
  status: string;
  statusReason: string | null;
  error: { name?: string; message?: string } | null;
  vault: string;
  subject: string;
  intent: Intent;
  display: Record<string, string>;
  requiredSigners: string[];
  appliedSignature: string | null;
  finalizedSlot: string | null;
  createdAt: string;
  attempts: {
    attemptNo: number;
    status: string;
    signature: string | null;
    signedBy: string[];
    blockhash: string;
    lastValidBlockHeight: string;
    confirmation: string | null;
    slot: string | null;
    sendCount: number;
    lastSendError: string | null;
  }[];
  plan: {
    transaction: string;
    attemptNo: number;
    signedBy: string[];
    memo: string;
    messageHash: string;
    programId: string;
    lastValidBlockHeight: string;
  } | null;
}

/** Intent fields the review drawer displays; the API returns the full JSON-safe intent. */
export interface Intent {
  kind?: string;
  termRateBps?: number;
  termSeconds?: string;
  offerExpiry?: string;
  borrower?: string;
  destination?: string;
  treasuryDestination?: string;
  approvers?: string[];
  perLoanLimit?: string;
  outstandingLimit?: string;
  paused?: boolean;
  expectedSeq?: string;
  [field: string]: unknown;
}

export interface Status {
  programId: string;
  network: string;
  finalizedHeight: string | null;
  worker: { worker_id: string; seen_at: string } | null;
}

/** Vault row with its finalized on-chain projection (`null` until the indexer syncs it). */
export interface Vault {
  address: string;
  approvers: string[];
  per_loan_limit: string;
  outstanding_limit: string;
  treasury_destination: string;
  onchain: boolean;
  outstanding_principal: string | null;
  disbursement_paused: boolean | null;
  pause_seq: string | null;
  cash: string | null;
  synced_slot: string | null;
}

export interface Loan {
  address: string;
  loan_ref: string;
  borrower: string;
  principal: string;
  fixed_payoff: string | null;
  offer_expiry: string;
  approvals: boolean[] | null;
  state: string | null;
  view: { status: string; dueAt?: string };
}

export interface Withdrawal {
  address: string;
  withdrawal_ref: string;
  amount: string;
  approvals: boolean[] | null;
  state: string | null;
}

export interface Statement {
  balanced: boolean;
  balances: { account: string; balance: string }[];
  exceptions: {
    id: string;
    kind: string;
    amount: string | null;
    signature: string;
  }[];
  postings: {
    id: string;
    slot: string;
    entry: string;
    account: string;
    debit: string;
    credit: string;
    business_ref: string | null;
    signature: string;
  }[];
  reconciliation: { matches: boolean };
}

export interface WebhookEvent {
  id: string;
  event_id: string;
  type: string;
  delivered_at: string | null;
  created_at: string;
}
