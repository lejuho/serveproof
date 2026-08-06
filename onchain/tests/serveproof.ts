import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createMint, getAccount, getAssociatedTokenAddressSync, mintTo } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { assert } from "chai";
import { Serveproof } from "../target/types/serveproof";

const sha256 = (s: string): number[] => [...createHash("sha256").update(s).digest()];

describe("serveproof settlement program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.serveproof as Program<Serveproof>;
  const admin = provider.wallet as anchor.Wallet;

  const venueAuthority = Keypair.generate();
  const wrongSigner = Keypair.generate();
  const workerWallet = Keypair.generate();

  const venueIdHash = sha256("venue:demo-diner");
  const allocationHash = sha256("allocation:batch-1");

  let usdcMint: PublicKey;
  let otherMint: PublicKey;
  let configPda: PublicKey;
  let venuePda: PublicKey;
  let vaultAuthorityPda: PublicKey;
  let venueVault: PublicKey;

  const paymentHash = (id: string) => sha256(`payment:${id}`);

  const settleAccounts = (overrides: Partial<Record<string, PublicKey>> = {}) => ({
    venue: venuePda,
    venueAuthority: venueAuthority.publicKey,
    workerWallet: workerWallet.publicKey,
    usdcMint,
    ...overrides,
  });

  before(async () => {
    // fund the venue authority and wrong signer
    const tx = new Transaction();
    for (const kp of [venueAuthority, wrongSigner]) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: kp.publicKey,
          lamports: 2 * LAMPORTS_PER_SOL,
        }),
      );
    }
    await provider.sendAndConfirm(tx);

    // tUSDC test mint, 6 decimals (spec §29.3)
    usdcMint = await createMint(provider.connection, admin.payer, admin.publicKey, null, 6);
    otherMint = await createMint(provider.connection, admin.payer, admin.publicKey, null, 6);

    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    [venuePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("venue"), Buffer.from(venueIdHash)],
      program.programId,
    );
    [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), venuePda.toBuffer()],
      program.programId,
    );
    venueVault = getAssociatedTokenAddressSync(usdcMint, vaultAuthorityPda, true);
  });

  it("initialize_config pins the USDC mint", async () => {
    await program.methods.initializeConfig().accounts({ usdcMint }).rpc();
    const config = await program.account.globalConfig.fetch(configPda);
    assert.equal(config.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(config.usdcMint.toBase58(), usdcMint.toBase58());
    assert.isFalse(config.paused);
  });

  it("register_venue stores authority and derives vault authority", async () => {
    await program.methods.registerVenue(venueIdHash, venueAuthority.publicKey).rpc();
    const venue = await program.account.venue.fetch(venuePda);
    assert.equal(venue.venueAuthority.toBase58(), venueAuthority.publicKey.toBase58());
    assert.equal(venue.vaultAuthority.toBase58(), vaultAuthorityPda.toBase58());
    assert.isTrue(venue.active);
  });

  it("register_venue rejects non-admin", async () => {
    try {
      await program.methods
        .registerVenue(sha256("venue:evil"), wrongSigner.publicKey)
        .accounts({ admin: wrongSigner.publicKey })
        .signers([wrongSigner])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(String(e), "Unauthorized");
    }
  });

  it("initialize_venue_vault creates the PDA-owned ATA and accepts funding", async () => {
    await program.methods.initializeVenueVault().accounts({ venue: venuePda, usdcMint }).rpc();
    // fund vault with 1,000 tUSDC
    await mintTo(
      provider.connection,
      admin.payer,
      usdcMint,
      venueVault,
      admin.payer,
      1_000_000_000,
    );
    const vault = await getAccount(provider.connection, venueVault);
    assert.equal(vault.owner.toBase58(), vaultAuthorityPda.toBase58());
    assert.equal(vault.amount, 1_000_000_000n);
  });

  it("settle_payout transfers USDC, creates the settlement record, emits event", async () => {
    const amount = new BN(50_880_000); // $50.88
    const [recordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("settlement"), Buffer.from(paymentHash("p1"))],
      program.programId,
    );

    let event: any = null;
    const listener = await program.addEventListener("payoutSettled", (e) => (event = e));

    await program.methods
      .settlePayout(paymentHash("p1"), allocationHash, amount)
      .accounts(settleAccounts())
      .signers([venueAuthority])
      .rpc();

    const workerAta = getAssociatedTokenAddressSync(usdcMint, workerWallet.publicKey);
    const workerAccount = await getAccount(provider.connection, workerAta);
    assert.equal(workerAccount.amount, 50_880_000n);

    const record = await program.account.settlementRecord.fetch(recordPda);
    assert.equal(record.amount.toNumber(), 50_880_000);
    assert.equal(record.status, 1); // SETTLED
    assert.equal(record.workerWallet.toBase58(), workerWallet.publicKey.toBase58());
    assert.deepEqual([...record.allocationHash], allocationHash);

    await new Promise((r) => setTimeout(r, 500));
    await program.removeEventListener(listener);
    assert.isNotNull(event, "PayoutSettled event not received");
    assert.equal(event.amount.toNumber(), 50_880_000);

    const vault = await getAccount(provider.connection, venueVault);
    assert.equal(vault.amount, 1_000_000_000n - 50_880_000n);
  });

  it("rejects duplicate payment (same paymentIdHash)", async () => {
    try {
      await program.methods
        .settlePayout(paymentHash("p1"), allocationHash, new BN(1_000_000))
        .accounts(settleAccounts())
        .signers([venueAuthority])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(String(e), "already in use");
    }
  });

  it("rejects wrong signer", async () => {
    try {
      await program.methods
        .settlePayout(paymentHash("p2"), allocationHash, new BN(1_000_000))
        .accounts(settleAccounts({ venueAuthority: wrongSigner.publicKey }))
        .signers([wrongSigner])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(String(e), "Unauthorized");
    }
  });

  it("rejects invalid mint", async () => {
    try {
      await program.methods
        .settlePayout(paymentHash("p3"), allocationHash, new BN(1_000_000))
        .accounts(settleAccounts({ usdcMint: otherMint }))
        .signers([venueAuthority])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      // The vault ATA constraint (associated_token::mint) trips before the
      // explicit address check — either way the wrong mint is rejected on-chain.
      assert.match(String(e), /InvalidMint|venue_vault|AssociatedToken|ConstraintAssociated/);
    }
  });

  it("rejects insufficient vault balance", async () => {
    try {
      await program.methods
        .settlePayout(paymentHash("p4"), allocationHash, new BN(10_000_000_000))
        .accounts(settleAccounts())
        .signers([venueAuthority])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(String(e), "InsufficientVaultBalance");
    }
  });

  it("rejects zero amount and zero allocation hash", async () => {
    try {
      await program.methods
        .settlePayout(paymentHash("p5"), allocationHash, new BN(0))
        .accounts(settleAccounts())
        .signers([venueAuthority])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(String(e), "ZeroAmount");
    }
    try {
      await program.methods
        .settlePayout(paymentHash("p6"), new Array(32).fill(0), new BN(1_000_000))
        .accounts(settleAccounts())
        .signers([venueAuthority])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(String(e), "ZeroAllocationHash");
    }
  });

  it("pause blocks settlement; unpause restores it", async () => {
    await program.methods.pause().rpc();
    try {
      await program.methods
        .settlePayout(paymentHash("p7"), allocationHash, new BN(1_000_000))
        .accounts(settleAccounts())
        .signers([venueAuthority])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(String(e), "ProtocolPaused");
    }
    await program.methods.unpause().rpc();
    await program.methods
      .settlePayout(paymentHash("p7"), allocationHash, new BN(1_000_000))
      .accounts(settleAccounts())
      .signers([venueAuthority])
      .rpc();
  });

  it("pause rejects non-admin", async () => {
    try {
      await program.methods
        .pause()
        .accounts({ admin: wrongSigner.publicKey })
        .signers([wrongSigner])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(String(e), "Unauthorized");
    }
  });

  it("mark_corrected sets CORRECTED status without deleting the record", async () => {
    const correctionHash = sha256("correction:refund-1");
    await program.methods
      .markCorrected(paymentHash("p1"), correctionHash, false)
      .accounts({ venue: venuePda, authority: venueAuthority.publicKey })
      .signers([venueAuthority])
      .rpc();

    const [recordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("settlement"), Buffer.from(paymentHash("p1"))],
      program.programId,
    );
    const record = await program.account.settlementRecord.fetch(recordPda);
    assert.equal(record.status, 2); // CORRECTED
    assert.deepEqual([...record.correctionReference], correctionHash);
    assert.equal(record.amount.toNumber(), 50_880_000); // original preserved
  });

  it("mark_corrected rejects unrelated signer", async () => {
    try {
      await program.methods
        .markCorrected(paymentHash("p1"), sha256("correction:evil"), false)
        .accounts({ venue: venuePda, authority: wrongSigner.publicKey })
        .signers([wrongSigner])
        .rpc();
      assert.fail("should have thrown");
    } catch (e: any) {
      assert.include(String(e), "Unauthorized");
    }
  });
});
