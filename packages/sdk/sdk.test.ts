/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  AccountRole,
  appendTransactionMessageInstruction,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  type Transaction,
} from "@solana/kit";

const root = new URL("../../", import.meta.url);
const entry = new URL("dist/index.js", import.meta.url);
const sdk = (await import(entry.href)) as typeof import("./src/index.js");
const artifact = await Bun.file(new URL("target/idl/forge.json", root)).json();

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const lifetime = { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n };

async function newAddress() {
  const pair = await generateKeyPair();
  return { pair, address: await getAddressFromPublicKey(pair.publicKey) };
}

async function sampleIntents() {
  const keys = await Promise.all(Array.from({ length: 10 }, newAddress));
  const [treasury, a, b, borrower, mint, source, dest, tdest] = keys.map((k) => k.address) as string[];
  const vaultId = await sdk.deriveOnchainId("vault", "inst-1", "main");
  const vault = await sdk.findVaultAddress(treasury as never, vaultId);
  const tokens = await sdk.findVaultTokenAddress(vault);
  const loanId = await sdk.deriveOnchainId("loan", vault, "LN-1");
  const loan = await sdk.findLoanAddress(vault, loanId);
  const withdrawalId = await sdk.deriveOnchainId("withdrawal", vault, "WD-1");
  const withdrawal = await sdk.findWithdrawalAddress(vault, withdrawalId);
  const intents: import("./src/index.js").ForgeIntent[] = [
    {
      kind: "create_vault",
      treasury: treasury!,
      vault,
      vaultId,
      mint: mint!,
      vaultTokenAccount: tokens,
      treasuryDestination: tdest!,
      approvers: [a!, b!],
      perLoanLimit: "5000000000",
      outstandingLimit: "10000000000",
    },
    { kind: "fund_vault", treasury: treasury!, vault, mint: mint!, source: source!, vaultTokenAccount: tokens, amount: "10000000000" },
    {
      kind: "propose_loan",
      approver: a!,
      vault,
      loan,
      loanId,
      borrower: borrower!,
      destination: dest!,
      mint: mint!,
      principal: "5000000000",
      termRateBps: 200,
      termSeconds: "2592000",
      offerExpiry: "1900000000",
    },
    { kind: "approve_loan", approver: b!, vault, loan },
    { kind: "draw_loan", borrower: borrower!, vault, loan, mint: mint!, vaultTokenAccount: tokens, destination: dest! },
    { kind: "repay_loan", borrower: borrower!, vault, loan, mint: mint!, borrowerTokens: dest!, vaultTokenAccount: tokens },
    { kind: "propose_withdrawal", approver: a!, vault, withdrawal, withdrawalId, amount: "100000000" },
    {
      kind: "approve_withdrawal",
      approver: b!,
      vault,
      withdrawal,
      mint: mint!,
      vaultTokenAccount: tokens,
      treasuryDestination: tdest!,
    },
    { kind: "set_disbursement_paused", approverA: a!, approverB: b!, vault, paused: true, expectedSeq: "3" },
  ];
  return { keys, intents };
}

describe("IDL packaging and drift", () => {
  test("packaged IDL equals the built program IDL", async () => {
    expect(sdk.forgeIdl).toEqual(artifact);
    expect(sdk.FORGE_PROGRAM_ID).toBe(artifact.address);
    expect(sdk.FORGE_PROGRAM_ADDRESS).toBe(artifact.address);
  });

  test("every IDL instruction has exactly one intent mapping covering all accounts and args", () => {
    const names = artifact.instructions.map((ix: { name: string }) => ix.name).sort();
    expect([...sdk.INTENT_KINDS].sort()).toEqual(names);
    for (const ix of artifact.instructions) {
      const spec = sdk.INTENT_SPECS[ix.name as keyof typeof sdk.INTENT_SPECS];
      const variable = ix.accounts.filter((a: { address?: string }) => !a.address).map((a: { name: string }) => a.name);
      expect(Object.keys(spec.accounts).sort()).toEqual(variable.sort());
      expect(Object.keys(spec.args).sort()).toEqual(ix.args.map((a: { name: string }) => a.name).sort());
      for (const signer of ix.accounts.filter((a: { signer?: boolean }) => a.signer)) {
        expect(spec.signers).toContain(spec.accounts[signer.name]!);
      }
    }
  });

  test("PDA helpers use the IDL's constant seed prefixes", () => {
    const prefixes = new Map<string, string>();
    for (const ix of artifact.instructions) {
      for (const account of ix.accounts) {
        const first = account.pda?.seeds?.[0];
        if (first?.kind === "const") prefixes.set(account.name, String.fromCharCode(...first.value));
      }
    }
    expect(prefixes.get("vault")).toBe("vault");
    expect(prefixes.get("vault_token_account")).toBe("tokens");
    expect(prefixes.get("loan")).toBe("loan");
    expect(prefixes.get("withdrawal")).toBe("withdrawal");
  });
});

describe("instruction codec", () => {
  test("every intent round-trips through the encoded instruction with IDL roles", async () => {
    const { intents } = await sampleIntents();
    for (const intent of intents) {
      const ix = sdk.buildForgeInstruction(intent);
      const idlIx = artifact.instructions.find((i: { name: string }) => i.name === intent.kind);
      expect(Array.from(ix.data!.slice(0, 8))).toEqual(idlIx.discriminator);
      ix.accounts!.forEach((meta, i) => {
        const expected = idlIx.accounts[i];
        const signer = meta.role === AccountRole.READONLY_SIGNER || meta.role === AccountRole.WRITABLE_SIGNER;
        const writable = meta.role === AccountRole.WRITABLE || meta.role === AccountRole.WRITABLE_SIGNER;
        expect(signer).toBe(Boolean(expected.signer));
        expect(writable).toBe(Boolean(expected.writable));
        if (expected.address) expect(meta.address).toBe(expected.address);
      });
      const decoded = sdk.decodeForgeInstruction({ programAddress: ix.programAddress, accounts: ix.accounts!, data: new Uint8Array(ix.data!) });
      expect(sdk.intentsEqual(decoded, intent)).toBe(true);
    }
  });

  test("out-of-range and malformed values are rejected rather than mis-encoded", async () => {
    const { intents } = await sampleIntents();
    const fund = intents[1] as import("./src/index.js").FundVaultIntent;
    expect(() => sdk.buildForgeInstruction({ ...fund, amount: "18446744073709551616" })).toThrow();
    expect(() => sdk.buildForgeInstruction({ ...fund, amount: "-1" })).toThrow();
    expect(() => sdk.buildForgeInstruction({ ...fund, amount: "1.5" })).toThrow();
    const vault = intents[0] as import("./src/index.js").CreateVaultIntent;
    expect(() => sdk.buildForgeInstruction({ ...vault, vaultId: "abcd" })).toThrow();
  });

  test("required signers put the fee payer first; pause needs both approvers", async () => {
    const { intents } = await sampleIntents();
    const pause = intents[8] as import("./src/index.js").SetDisbursementPausedIntent;
    expect(sdk.requiredSigners(pause)).toEqual([pause.approverA, pause.approverB]);
    expect(sdk.intentSubject(intents[2]!)).toBe((intents[2] as { loan: string }).loan);
  });
});

describe("plans, signing and verification", () => {
  test("a compiled plan verifies against its intent and detects tampering", async () => {
    const { intents } = await sampleIntents();
    for (const intent of intents) {
      const tx = sdk.compileIntentTransaction(intent, lifetime);
      const plan = {
        intent,
        transaction: sdk.encodeWireTransaction(tx),
        messageHash: await sdk.messageHash(tx),
        requiredSigners: sdk.requiredSigners(intent),
      };
      expect(await sdk.verifyPlan(plan)).toEqual([]);
      const inspected = sdk.inspectTransaction(tx);
      expect(inspected.feePayer).toBe(sdk.requiredSigners(intent)[0]!);
      expect(inspected.blockhash).toBe(BLOCKHASH);
    }
    const fund = intents[1] as import("./src/index.js").FundVaultIntent;
    const tx = sdk.compileIntentTransaction(fund, lifetime);
    const plan = {
      intent: fund,
      transaction: sdk.encodeWireTransaction(tx),
      messageHash: await sdk.messageHash(tx),
      requiredSigners: sdk.requiredSigners(fund),
    };
    // The signer asked for 1 token; a plan for 10,000 must fail review.
    expect(await sdk.verifyPlan(plan, { ...fund, amount: "1000000" })).toContain(
      "Encoded instruction does not match the intent",
    );
    expect(await sdk.verifyPlan({ ...plan, messageHash: "00" })).toContain("Message hash mismatch");
  });

  test("an extra instruction in the bytes fails review", async () => {
    const { intents } = await sampleIntents();
    const fund = intents[1]!;
    const extra = sdk.buildForgeInstruction(intents[0]!);
    const tx = sdk.compileIntentTransaction(fund, lifetime);
    const msg = sdk.inspectTransaction(tx);
    expect(msg.instructions).toHaveLength(1);
    const { compileTransaction, createTransactionMessage, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, address } = await import("@solana/kit");
    const tampered = compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(sdk.requiredSigners(fund)[0]!), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 1n }, m),
        (m) => appendTransactionMessageInstruction(sdk.buildForgeInstruction(fund), m),
        (m) => appendTransactionMessageInstruction(extra, m),
      ),
    );
    const problems = await sdk.verifyPlan({
      intent: fund,
      transaction: getBase64EncodedWireTransaction(tampered),
      messageHash: await sdk.messageHash(tampered),
      requiredSigners: sdk.requiredSigners(fund),
    });
    expect(problems.some((p) => p.startsWith("Expected 1 instruction"))).toBe(true);
  });

  test("partial signatures merge; altered messages and forged signatures are rejected", async () => {
    const a = await newAddress();
    const b = await newAddress();
    const { intents } = await sampleIntents();
    const pause = { ...(intents[8] as import("./src/index.js").SetDisbursementPausedIntent), approverA: a.address, approverB: b.address };
    const stored = sdk.compileIntentTransaction(pause, lifetime);
    const unsigned = sdk.encodeWireTransaction(stored);

    const signedByA = await sdk.signPlanTransaction(unsigned, [a.pair]);
    const first = await sdk.mergeSignatures(stored, sdk.decodeWireTransaction(signedByA));
    expect(first.added).toEqual([a.address]);
    expect(sdk.isFullySigned(first.transaction)).toBe(false);

    const signedByB = await sdk.signPlanTransaction(unsigned, [b.pair]);
    const second = await sdk.mergeSignatures(first.transaction, sdk.decodeWireTransaction(signedByB));
    expect(second.added).toEqual([b.address]);
    expect(sdk.isFullySigned(second.transaction)).toBe(true);
    expect((await sdk.checkSignatures(second.transaction)).every((c) => c.status === "valid")).toBe(true);
    expect(sdk.transactionSignature(second.transaction)).toBeString();

    // Re-submitting the same signature is idempotent.
    const again = await sdk.mergeSignatures(second.transaction, sdk.decodeWireTransaction(signedByA));
    expect(again.added).toEqual([]);

    // A signature over different bytes (new blockhash) is rejected.
    const other = sdk.compileIntentTransaction(pause, { ...lifetime, blockhash: "11111111111111111111111111111111" });
    const otherSigned = await sdk.signPlanTransaction(sdk.encodeWireTransaction(other), [a.pair]);
    await expect(sdk.mergeSignatures(stored, sdk.decodeWireTransaction(otherSigned))).rejects.toThrow("differs");

    // A forged signature slot is rejected.
    const forged: Transaction = {
      ...sdk.decodeWireTransaction(signedByA),
      signatures: { ...stored.signatures, [b.address]: new Uint8Array(64).fill(7) },
    } as Transaction;
    await expect(sdk.mergeSignatures(stored, forged)).rejects.toThrow("Invalid signature");
  });
});

describe("errors, accounts and views", () => {
  test("transaction errors are classified for reconciliation", () => {
    const at = (code: number | bigint) => ({ InstructionError: [0, { Custom: code }] });
    expect(sdk.decodeTransactionError(at(6010)).category).toBe("replay");
    expect(sdk.decodeTransactionError(at(6011)).name).toBe("AlreadyApproved");
    expect(sdk.decodeTransactionError(at(6018n)).name).toBe("InvalidWithdrawalState");
    expect(sdk.decodeTransactionError(at(6015)).category).toBe("rejected");
    expect(sdk.decodeTransactionError(at(6019)).name).toBe("StalePauseSequence");
    expect(sdk.decodeTransactionError(at(6004)).category).toBe("unauthorized");
    expect(sdk.decodeTransactionError(at(2012)).name).toBe("ConstraintAddress");
    expect(sdk.decodeTransactionError(at(0), ["propose_loan"])).toMatchObject({ name: "AccountAlreadyInUse", category: "replay" });
    expect(sdk.decodeTransactionError(at(1), ["repay_loan"])).toMatchObject({ name: "InsufficientFunds", category: "token" });
    expect(sdk.decodeTransactionError("BlockhashNotFound").category).toBe("transaction");
  });

  test("account decoders read IDL layouts", async () => {
    const { encodeWithDiscriminator } = await import("./src/codec.js");
    const { idl, idlTypeDef } = await import("./src/idl.js");
    const def = idlTypeDef("Withdrawal");
    if (def.type.kind !== "struct") throw new Error("struct expected");
    const vault = (await newAddress()).address;
    const disc = idl.accounts.find((a) => a.name === "Withdrawal")!.discriminator;
    const data = encodeWithDiscriminator(disc, def.type.fields, {
      vault,
      withdrawal_id: new Uint8Array(32).fill(1),
      amount: 42n,
      approvals: [true, false],
      state: "Proposed",
      proposed_at: 10n,
      executed_at: 0n,
      bump: 254,
    });
    const decoded = sdk.decodeWithdrawalAccount(data);
    expect(decoded).toMatchObject({ vault, amount: 42n, approvals: [true, false], state: "Proposed", bump: 254 });
    expect(decoded.withdrawalId).toBe("01".repeat(32));
    expect(sdk.decodeForgeAccount(data)?.type).toBe("Withdrawal");
    expect(() => sdk.decodeVaultAccount(data)).toThrow();
  });

  test("loan views compute expiry and overdue without stored states", () => {
    const base = { offerExpiry: 100n, disbursedAt: 0n, termSeconds: 50n };
    expect(sdk.loanView({ ...base, state: "Approved" }, 100n).status).toBe("approved");
    expect(sdk.loanView({ ...base, state: "Approved" }, 101n).status).toBe("offer_expired");
    expect(sdk.loanView({ ...base, state: "Active", disbursedAt: 10n }, 60n)).toEqual({ status: "active", dueAt: 60n });
    expect(sdk.loanView({ ...base, state: "Active", disbursedAt: 10n }, 61n).status).toBe("overdue");
    expect(sdk.loanView({ ...base, state: "Repaid", disbursedAt: 10n }, 999n).status).toBe("repaid");
  });

  test("token amounts parse and format in integer base units", () => {
    expect(sdk.parseTokenAmount("10000")).toBe(10_000_000_000n);
    expect(sdk.parseTokenAmount("0.000001")).toBe(1n);
    expect(() => sdk.parseTokenAmount("0.0000001")).toThrow();
    expect(sdk.formatTokenAmount(10_100_000_000n)).toBe("10,100.000000");
  });

  test("on-chain ids are deterministic per scope and reference", async () => {
    const a = await sdk.deriveOnchainId("loan", "vault-1", "LN-1");
    expect(a).toHaveLength(64);
    expect(await sdk.deriveOnchainId("loan", "vault-1", "LN-1")).toBe(a);
    expect(await sdk.deriveOnchainId("loan", "vault-2", "LN-1")).not.toBe(a);
    expect(await sdk.deriveOnchainId("withdrawal", "vault-1", "LN-1")).not.toBe(a);
  });
});
