// Venue-scoped Devnet bootstrap. Every write is simulated before broadcast.
// Usage: NO_DNA=1 node scripts/init-devnet.mjs <demo|smoke>
import * as anchor from "@anchor-lang/core";
import {
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { DEMO_CONFIG } from "../../scripts/demo-config.mjs";

const profile = process.argv[2];
if (!["demo", "smoke"].includes(profile)) {
  throw new Error("usage: NO_DNA=1 node scripts/init-devnet.mjs <demo|smoke>");
}
if (process.env.NO_DNA !== "1") {
  throw new Error("Refusing interactive bootstrap without NO_DNA=1");
}

const stateFile = new URL(`../state/devnet-${profile}.json`, import.meta.url);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const venueId = profile === "demo" ? DEMO_CONFIG.venueId : state.venueId;
if (!venueId) throw new Error(`Missing venueId in ${stateFile.pathname}`);

const rpcUrl = process.env.DEMO_SOLANA_RPC_URL ?? DEMO_CONFIG.devnet.rpcUrl;
const walletKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))),
);
const connection = new Connection(rpcUrl, "confirmed");
const wallet = new anchor.Wallet(walletKp);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
anchor.setProvider(provider);
const idl = JSON.parse(
  readFileSync(new URL("../target/idl/serveproof.json", import.meta.url), "utf8"),
);
const program = new anchor.Program(idl, provider);
const programId = program.programId;
const usdcMint = new PublicKey(DEMO_CONFIG.devnet.usdcMint);
const sha256 = (value) => [...createHash("sha256").update(value).digest()];

if (programId.toBase58() !== DEMO_CONFIG.devnet.programId) {
  throw new Error(`Program mismatch: ${programId.toBase58()}`);
}
if (walletKp.publicKey.toBase58() !== DEMO_CONFIG.devnet.venueAuthority) {
  throw new Error(`Authority mismatch: ${walletKp.publicKey.toBase58()}`);
}

const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
const venueIdHash = sha256(venueId);
const [venuePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("venue"), Buffer.from(venueIdHash)],
  programId,
);
const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault_authority"), venuePda.toBuffer()],
  programId,
);
const venueVault = getAssociatedTokenAddressSync(usdcMint, vaultAuthorityPda, true);

console.log("Transaction plan:");
console.log(`  cluster: devnet (${rpcUrl})`);
console.log(`  program: ${programId.toBase58()}`);
console.log(`  profile: ${profile}`);
console.log(`  venue ID: ${venueId}`);
console.log(`  venue PDA: ${venuePda.toBase58()}`);
console.log(`  vault: ${venueVault.toBase58()}`);
console.log(`  authority / fee payer: ${walletKp.publicKey.toBase58()}`);
console.log(`  mint: ${usdcMint.toBase58()} (test asset)`);

async function simulateAnchor(label, method) {
  const result = await method.simulate();
  console.log(`SIMULATION OK ${label}`);
  for (const log of (result.raw ?? []).slice(-8)) console.log(`  ${log}`);
}

const [configInfo, mintInfo] = await Promise.all([
  connection.getAccountInfo(configPda, "confirmed"),
  connection.getAccountInfo(usdcMint, "confirmed"),
]);
if (!configInfo || !configInfo.owner.equals(programId)) {
  throw new Error("GlobalConfig is missing or not owned by ServeProof");
}
if (!mintInfo) throw new Error("Configured tUSDC mint does not exist");
const config = await program.account.globalConfig.fetch(configPda);
if (config.admin.toBase58() !== walletKp.publicKey.toBase58()) {
  throw new Error(`GlobalConfig admin mismatch: ${config.admin.toBase58()}`);
}
if (config.usdcMint.toBase58() !== usdcMint.toBase58()) {
  throw new Error(`GlobalConfig mint mismatch: ${config.usdcMint.toBase58()}`);
}

if (await connection.getAccountInfo(venuePda, "confirmed")) {
  const venue = await program.account.venue.fetch(venuePda);
  if (venue.venueAuthority.toBase58() !== walletKp.publicKey.toBase58()) {
    throw new Error(`Existing venue authority mismatch: ${venue.venueAuthority.toBase58()}`);
  }
  console.log(`SKIP register_venue: ${venuePda.toBase58()} already exists`);
} else {
  const register = program.methods.registerVenue(venueIdHash, walletKp.publicKey);
  await simulateAnchor("register_venue", register);
  const signature = await register.rpc();
  console.log(`SENT register_venue: ${signature}`);
}

if (await connection.getAccountInfo(venueVault, "confirmed")) {
  console.log(`SKIP initialize_venue_vault: ${venueVault.toBase58()} already exists`);
} else {
  const initializeVault = program.methods
    .initializeVenueVault()
    .accounts({ venue: venuePda, usdcMint });
  await simulateAnchor("initialize_venue_vault", initializeVault);
  const signature = await initializeVault.rpc();
  console.log(`SENT initialize_venue_vault: ${signature}`);
}

const mint = await getMint(connection, usdcMint, "confirmed");
if (!mint.mintAuthority?.equals(walletKp.publicKey)) {
  throw new Error(`Mint authority is not ${walletKp.publicKey.toBase58()}`);
}
const vaultAccount = await getAccount(connection, venueVault, "confirmed");
if (!vaultAccount.owner.equals(vaultAuthorityPda) || !vaultAccount.mint.equals(usdcMint)) {
  throw new Error("Vault owner or mint does not match the derived canonical account");
}
const target = 500_000_000n;
if (vaultAccount.amount < target) {
  const amount = target - vaultAccount.amount;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: walletKp.publicKey,
    recentBlockhash: blockhash,
  }).add(createMintToInstruction(usdcMint, venueVault, walletKp.publicKey, amount));
  transaction.sign(walletKp);
  // web3.js legacy Transaction overload accepts the signer array rather than
  // the VersionedTransaction config object. It signs and verifies the exact
  // instruction set without broadcasting it.
  const simulation = await connection.simulateTransaction(transaction, [walletKp]);
  if (simulation.value.err) {
    throw new Error(`mint_to simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }
  console.log(`SIMULATION OK mint_to ${Number(amount) / 1e6} tUSDC`);
  for (const log of (simulation.value.logs ?? []).slice(-8)) console.log(`  ${log}`);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`SENT mint_to: ${signature}`);
} else {
  console.log(`SKIP mint_to: vault already has ${Number(vaultAccount.amount) / 1e6} tUSDC`);
}

const finalVault = await getAccount(connection, venueVault, "confirmed");
const nextState = {
  profile,
  usdcMint: usdcMint.toBase58(),
  programId: programId.toBase58(),
  venueId,
  venuePda: venuePda.toBase58(),
  vaultAuthorityPda: vaultAuthorityPda.toBase58(),
  venueVault: venueVault.toBase58(),
  venueAuthority: walletKp.publicKey.toBase58(),
  vaultBalance: Number(finalVault.amount) / 1e6,
  updatedAt: new Date().toISOString(),
};
writeFileSync(stateFile, `${JSON.stringify(nextState, null, 2)}\n`);
console.log(`READY ${profile}: ${Number(finalVault.amount) / 1e6} tUSDC`);
console.log(`State saved: ${stateFile.pathname}`);
