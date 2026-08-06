// Devnet smoke test: one real settle_payout, then verify duplicate rejection.
// Usage: node scripts/smoke-settle.mjs
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const state = JSON.parse(readFileSync(new URL("../devnet-state.json", import.meta.url), "utf8"));
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

const walletKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
);
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(walletKp), {
  commitment: "confirmed",
});
anchor.setProvider(provider);
const idl = JSON.parse(
  readFileSync(new URL("../target/idl/serveproof.json", import.meta.url), "utf8"),
);
const program = new anchor.Program(idl, provider);

const sha256 = (s) => [...createHash("sha256").update(s).digest()];

const paymentId = `smoke-${process.env.SMOKE_ID ?? "0001"}`;
const paymentIdHash = sha256(`payment:${paymentId}`);
const allocationHash = sha256("allocation:smoke");
const workerWallet = Keypair.generate().publicKey;
const usdcMint = new PublicKey(state.usdcMint);
const venuePda = new PublicKey(state.venuePda);

const amount = new anchor.BN(26_720_000); // $26.72 — Worker C's demo allocation

const sig = await program.methods
  .settlePayout(paymentIdHash, allocationHash, amount)
  .accounts({ venue: venuePda, venueAuthority: walletKp.publicKey, workerWallet, usdcMint })
  .rpc();
console.log("settle_payout tx:", sig);

const workerAta = getAssociatedTokenAddressSync(usdcMint, workerWallet);
const account = await getAccount(connection, workerAta);
console.log(`worker ${workerWallet.toBase58()} received ${Number(account.amount) / 1e6} tUSDC`);

const [recordPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("settlement"), Buffer.from(paymentIdHash)],
  program.programId,
);
const record = await program.account.settlementRecord.fetch(recordPda);
console.log("settlement record:", recordPda.toBase58(), "status:", record.status);

try {
  await program.methods
    .settlePayout(paymentIdHash, allocationHash, amount)
    .accounts({ venue: venuePda, venueAuthority: walletKp.publicKey, workerWallet, usdcMint })
    .rpc();
  console.error("!! duplicate was NOT rejected");
  process.exit(1);
} catch {
  console.log("duplicate payment correctly rejected");
}
