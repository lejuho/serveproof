/**
 * Anchor IDL-based client for the ServeProof settlement program (spec §13–§16).
 *
 * Hash conventions (must match onchain/scripts and the deployed state):
 * - venueIdHash   = sha256(utf8(venue UUID))
 * - paymentIdHash = sha256(utf8(paymentId))
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnchorProvider, BN, Program, Wallet } from "@anchor-lang/core";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";

const idl = JSON.parse(readFileSync(join(__dirname, "idl.json"), "utf8"));

export const PDA_SEEDS = {
  config: "config",
  venue: "venue",
  vaultAuthority: "vault_authority",
  settlement: "settlement",
} as const;

export function sha256Bytes(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

export interface ServeproofPdas {
  config: PublicKey;
  venue: PublicKey;
  vaultAuthority: PublicKey;
  venueVault: PublicKey;
}

export function deriveVenuePdas(
  programId: PublicKey,
  venueId: string,
  usdcMint: PublicKey,
): ServeproofPdas {
  const [config] = PublicKey.findProgramAddressSync([Buffer.from(PDA_SEEDS.config)], programId);
  const [venue] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.venue), sha256Bytes(venueId)],
    programId,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.vaultAuthority), venue.toBuffer()],
    programId,
  );
  const venueVault = getAssociatedTokenAddressSync(usdcMint, vaultAuthority, true);
  return { config, venue, vaultAuthority, venueVault };
}

export function deriveSettlementPda(programId: PublicKey, paymentId: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PDA_SEEDS.settlement), sha256Bytes(paymentId)],
    programId,
  );
  return pda;
}

/** Read-only Program instance (dummy wallet — never signs). */
export function getProgram(connection: Connection): Program {
  const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), {
    commitment: "confirmed",
  });
  return new Program(idl as never, provider);
}

export interface BuildSettleTxParams {
  connection: Connection;
  venueId: string;
  paymentId: string;
  /** hex-encoded 32-byte allocation hash from the approved batch */
  allocationHashHex: string;
  amountBaseUnits: bigint;
  venueAuthority: PublicKey;
  workerWallet: PublicKey;
  usdcMint: PublicKey;
}

export interface BuiltSettleTx {
  /** base64-serialized unsigned transaction (requires venueAuthority signature) */
  transactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
  settlementPda: string;
  paymentIdHashHex: string;
}

/**
 * Spec §29.4 — the backend builds an UNSIGNED transaction; the venue wallet
 * signs it client-side. The backend never holds the vault withdrawal key.
 */
export async function buildSettlePayoutTx(params: BuildSettleTxParams): Promise<BuiltSettleTx> {
  const program = getProgram(params.connection);
  const paymentIdHash = sha256Bytes(params.paymentId);
  const allocationHash = Buffer.from(params.allocationHashHex, "hex");
  if (allocationHash.length !== 32) {
    throw new Error("allocationHashHex must be 32 bytes of hex");
  }

  const pdas = deriveVenuePdas(program.programId, params.venueId, params.usdcMint);

  const settlePayout = program.methods.settlePayout;
  if (!settlePayout) throw new Error("IDL is missing the settle_payout instruction");
  const tx: Transaction = await settlePayout(
    [...paymentIdHash],
    [...allocationHash],
    new BN(params.amountBaseUnits.toString()),
  )
    .accounts({
      venue: pdas.venue,
      venueAuthority: params.venueAuthority,
      workerWallet: params.workerWallet,
      usdcMint: params.usdcMint,
    })
    .transaction();

  const { blockhash, lastValidBlockHeight } =
    await params.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = params.venueAuthority;

  return {
    transactionBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    blockhash,
    lastValidBlockHeight,
    settlementPda: deriveSettlementPda(program.programId, params.paymentId).toBase58(),
    paymentIdHashHex: paymentIdHash.toString("hex"),
  };
}

export interface SettlementRecordView {
  paymentIdHashHex: string;
  allocationHashHex: string;
  venue: string;
  workerWallet: string;
  amount: bigint;
  status: number; // 1=SETTLED 2=CORRECTED 3=DISPUTED
  settledAt: number;
}

export async function fetchSettlementRecord(
  connection: Connection,
  paymentId: string,
): Promise<SettlementRecordView | null> {
  const program = getProgram(connection);
  const pda = deriveSettlementPda(program.programId, paymentId);
  const record = await (
    program.account as never as {
      settlementRecord: { fetchNullable(pk: PublicKey): Promise<Record<string, unknown> | null> };
    }
  ).settlementRecord.fetchNullable(pda);
  if (!record) return null;
  return {
    paymentIdHashHex: Buffer.from(record.paymentIdHash as number[]).toString("hex"),
    allocationHashHex: Buffer.from(record.allocationHash as number[]).toString("hex"),
    venue: (record.venue as PublicKey).toBase58(),
    workerWallet: (record.workerWallet as PublicKey).toBase58(),
    amount: BigInt((record.amount as BN).toString()),
    status: record.status as number,
    settledAt: Number((record.settledAt as BN).toString()),
  };
}

/** Decode a base58 pubkey, throwing a friendly error for invalid addresses. */
export function parsePubkey(address: string): PublicKey {
  try {
    return new PublicKey(address);
  } catch {
    throw new Error(`Invalid Solana address: ${address}`);
  }
}
