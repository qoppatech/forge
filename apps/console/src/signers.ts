import { createKeyPairFromPrivateKeyBytes } from "@solana/kit";
import { hexToBytes } from "@forge/sdk";

import type { Role, Session } from "./api";

export interface DemoSigner {
  role: Role;
  label: string;
  address: string;
  keyPair: CryptoKeyPair;
}

export const ROLE_LABELS: Record<Role, string> = {
  treasury: "Treasury",
  approverA: "Approver A",
  approverB: "Approver B",
  borrower: "Borrower",
};

/**
 * Demonstration wallets held only in this browser tab (non-extractable Web Crypto keys). They
 * stand in for each actor's own wallet or custody; the FORGE API never receives them.
 */
export async function loadSigners(session: Session): Promise<Record<Role, DemoSigner>> {
  const entries = await Promise.all(
    (Object.keys(ROLE_LABELS) as Role[]).map(async (role) => {
      const wallet = session.wallets[role];
      const keyPair = await createKeyPairFromPrivateKeyBytes(hexToBytes(wallet.seed, 32));
      return [role, { role, label: ROLE_LABELS[role], address: wallet.address, keyPair }] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Role, DemoSigner>;
}

export function roleOf(signers: Record<Role, DemoSigner>, address: string): DemoSigner | undefined {
  return Object.values(signers).find((s) => s.address === address);
}
