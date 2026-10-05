import { getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";

import { bytesToHex, hexToBytes, sha256 } from "./bytes.js";
import { FORGE_PROGRAM_ADDRESS } from "./idl.js";

const addressEncoder = getAddressEncoder();

async function derive(seeds: (string | Uint8Array)[]): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: FORGE_PROGRAM_ADDRESS,
    seeds,
  });
  return pda;
}

/** `["vault", treasury, vault_id]` */
export function findVaultAddress(treasury: Address, vaultIdHex: string): Promise<Address> {
  return derive(["vault", new Uint8Array(addressEncoder.encode(treasury)), hexToBytes(vaultIdHex, 32)]);
}

/** `["tokens", vault]` — SPL token account owned by the token program, authority = vault PDA. */
export function findVaultTokenAddress(vault: Address): Promise<Address> {
  return derive(["tokens", new Uint8Array(addressEncoder.encode(vault))]);
}

/** `["loan", vault, loan_id]` */
export function findLoanAddress(vault: Address, loanIdHex: string): Promise<Address> {
  return derive(["loan", new Uint8Array(addressEncoder.encode(vault)), hexToBytes(loanIdHex, 32)]);
}

/** `["withdrawal", vault, withdrawal_id]` */
export function findWithdrawalAddress(vault: Address, withdrawalIdHex: string): Promise<Address> {
  return derive([
    "withdrawal",
    new Uint8Array(addressEncoder.encode(vault)),
    hexToBytes(withdrawalIdHex, 32),
  ]);
}

/**
 * Derives a 32-byte on-chain identifier from a business reference so that retried requests
 * target the same PDA: `sha256("forge:<kind>:v1|<scope>|<reference>")`.
 */
export async function deriveOnchainId(
  kind: "vault" | "loan" | "withdrawal",
  scope: string,
  reference: string,
): Promise<string> {
  if (!reference) throw new TypeError("A business reference is required");
  return bytesToHex(await sha256(`forge:${kind}:v1|${scope}|${reference}`));
}
