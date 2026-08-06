// Devnet bootstrap (spec §29.3): tUSDC mint → initialize_config →
// register demo venue → initialize vault → fund vault.
// Idempotent: skips steps whose accounts already exist.
//
// Usage: node scripts/init-devnet.mjs <demo-venue-uuid>
import * as anchor from "@anchor-lang/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMint, getAssociatedTokenAddressSync, getAccount, mintTo } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const VENUE_ID = process.argv[2];
if (!VENUE_ID) throw new Error("usage: node scripts/init-devnet.mjs <venue-uuid>");

const STATE_FILE = new URL("../devnet-state.json", import.meta.url).pathname;
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};

const walletKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
);
const connection = new Connection(RPC, "confirmed");
const wallet = new anchor.Wallet(walletKp);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
anchor.setProvider(provider);

const idl = JSON.parse(
  readFileSync(new URL("../target/idl/serveproof.json", import.meta.url), "utf8"),
);
const program = new anchor.Program(idl, provider);
const programId = program.programId;
console.log("program:", programId.toBase58(), "| wallet:", walletKp.publicKey.toBase58());

const sha256 = (s) => [...createHash("sha256").update(s).digest()];

// 1) tUSDC mint
let usdcMint;
if (state.usdcMint) {
  usdcMint = new PublicKey(state.usdcMint);
  console.log("mint exists:", state.usdcMint);
} else {
  usdcMint = await createMint(connection, walletKp, walletKp.publicKey, null, 6);
  state.usdcMint = usdcMint.toBase58();
  console.log("created tUSDC mint:", state.usdcMint);
}

// 2) initialize_config
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
if (await connection.getAccountInfo(configPda)) {
  console.log("config exists:", configPda.toBase58());
} else {
  const sig = await program.methods.initializeConfig().accounts({ usdcMint }).rpc();
  console.log("initialize_config:", sig);
}

// 3) register demo venue (venueIdHash = sha256(venue UUID))
const venueIdHash = sha256(VENUE_ID);
const [venuePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("venue"), Buffer.from(venueIdHash)],
  programId,
);
const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault_authority"), venuePda.toBuffer()],
  programId,
);
if (await connection.getAccountInfo(venuePda)) {
  console.log("venue exists:", venuePda.toBase58());
} else {
  const sig = await program.methods.registerVenue(venueIdHash, walletKp.publicKey).rpc();
  console.log("register_venue:", sig, "→", venuePda.toBase58());
}

// 4) initialize vault
const venueVault = getAssociatedTokenAddressSync(usdcMint, vaultAuthorityPda, true);
if (await connection.getAccountInfo(venueVault)) {
  console.log("vault exists:", venueVault.toBase58());
} else {
  const sig = await program.methods
    .initializeVenueVault()
    .accounts({ venue: venuePda, usdcMint })
    .rpc();
  console.log("initialize_venue_vault:", sig, "→", venueVault.toBase58());
}

// 5) fund vault to at least 500 tUSDC
const vaultAccount = await getAccount(connection, venueVault);
const target = 500_000_000n;
if (vaultAccount.amount < target) {
  await mintTo(connection, walletKp, usdcMint, venueVault, walletKp, target - vaultAccount.amount);
  console.log(`funded vault to 500 tUSDC`);
} else {
  console.log(`vault balance: ${Number(vaultAccount.amount) / 1e6} tUSDC`);
}

state.programId = programId.toBase58();
state.venueId = VENUE_ID;
state.venuePda = venuePda.toBase58();
state.vaultAuthorityPda = vaultAuthorityPda.toBase58();
state.venueVault = venueVault.toBase58();
state.venueAuthority = walletKp.publicKey.toBase58();
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
console.log("state saved →", STATE_FILE);
