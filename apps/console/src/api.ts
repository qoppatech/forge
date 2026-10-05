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
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function loadSession(): Promise<Session | null> {
  const response = await fetch("/dev/session");
  return response.ok ? ((await response.json()) as Session) : null;
}

export function createApi(apiKey: string) {
  return async function request<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = crypto.randomUUID();
    }
    const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (!response.ok) {
      const error = payload.error ?? {};
      throw new ApiError(response.status, error.code ?? "error", error.message ?? response.statusText);
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
  intent: Record<string, any>;
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
  plan: (Record<string, any> & { transaction: string; attemptNo: number; signedBy: string[] }) | null;
}
