use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("A2snJHtFRK8wKawieDTQy6wMReJCP3BxU6i6y9aECJhi");

// Spec §13 — PDA seeds (mirrored in packages/solana PDA_SEEDS)
pub const CONFIG_SEED: &[u8] = b"config";
pub const VENUE_SEED: &[u8] = b"venue";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";

pub const SETTLEMENT_STATUS_SETTLED: u8 = 1;
pub const SETTLEMENT_STATUS_CORRECTED: u8 = 2;
pub const SETTLEMENT_STATUS_DISPUTED: u8 = 3;

#[program]
pub mod serveproof {
    use super::*;

    /// Spec §14.1 — create GlobalConfig, pin the USDC mint.
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.paused = false;
        config.version = 1;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Spec §14.2 — admin registers a venue; VaultAuthority PDA is derived.
    pub fn register_venue(
        ctx: Context<RegisterVenue>,
        venue_id_hash: [u8; 32],
        venue_authority: Pubkey,
    ) -> Result<()> {
        let venue_key = ctx.accounts.venue.key();
        let (vault_authority, _) =
            Pubkey::find_program_address(&[VAULT_AUTHORITY_SEED, venue_key.as_ref()], &crate::ID);

        let venue = &mut ctx.accounts.venue;
        venue.venue_id_hash = venue_id_hash;
        venue.venue_authority = venue_authority;
        venue.vault_authority = vault_authority;
        venue.active = true;
        venue.created_at = Clock::get()?.unix_timestamp;
        venue.bump = ctx.bumps.venue;

        emit!(VenueRegistered {
            venue: venue_key,
            venue_id_hash,
            venue_authority,
        });
        Ok(())
    }

    /// Spec §14.3 — create the venue USDC ATA owned by the VaultAuthority PDA.
    pub fn initialize_venue_vault(ctx: Context<InitializeVenueVault>) -> Result<()> {
        emit!(VaultInitialized {
            venue: ctx.accounts.venue.key(),
            vault: ctx.accounts.venue_vault.key(),
        });
        Ok(())
    }

    /// Spec §14.4 — settle one approved worker allocation as a USDC transfer.
    /// Duplicate payments are impossible: the SettlementRecord PDA is seeded by
    /// payment_id_hash and `init` fails if it already exists.
    pub fn settle_payout(
        ctx: Context<SettlePayout>,
        payment_id_hash: [u8; 32],
        allocation_hash: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        // Checks 1–2 (3–7 are enforced by account constraints below)
        require!(!ctx.accounts.config.paused, SpError::ProtocolPaused);
        require!(ctx.accounts.venue.active, SpError::VenueInactive);
        // Checks 8–10
        require!(
            ctx.accounts.venue_vault.amount >= amount,
            SpError::InsufficientVaultBalance
        );
        require!(allocation_hash != [0u8; 32], SpError::ZeroAllocationHash);
        require!(amount > 0, SpError::ZeroAmount);

        // transfer_checked from vault, signed by the VaultAuthority PDA
        let venue_key = ctx.accounts.venue.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_AUTHORITY_SEED,
            venue_key.as_ref(),
            &[ctx.bumps.vault_authority],
        ]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.venue_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.worker_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        let record = &mut ctx.accounts.settlement_record;
        record.payment_id_hash = payment_id_hash;
        record.allocation_hash = allocation_hash;
        record.venue = venue_key;
        record.worker_wallet = ctx.accounts.worker_wallet.key();
        record.amount = amount;
        record.status = SETTLEMENT_STATUS_SETTLED;
        record.settled_at = Clock::get()?.unix_timestamp;
        record.correction_reference = [0u8; 32];
        record.bump = ctx.bumps.settlement_record;

        emit!(PayoutSettled {
            payment_id_hash,
            allocation_hash,
            venue: venue_key,
            worker_wallet: ctx.accounts.worker_wallet.key(),
            amount,
        });
        Ok(())
    }

    /// Spec §14.5 — never delete: mark the settlement CORRECTED/DISPUTED and
    /// store the correction reference hash.
    pub fn mark_corrected(
        ctx: Context<MarkCorrected>,
        _payment_id_hash: [u8; 32],
        correction_hash: [u8; 32],
        disputed: bool,
    ) -> Result<()> {
        let record = &mut ctx.accounts.settlement_record;
        record.status = if disputed {
            SETTLEMENT_STATUS_DISPUTED
        } else {
            SETTLEMENT_STATUS_CORRECTED
        };
        record.correction_reference = correction_hash;

        emit!(SettlementCorrected {
            payment_id_hash: record.payment_id_hash,
            correction_hash,
            disputed,
        });
        Ok(())
    }

    /// Spec §14.6 — admin-only circuit breaker.
    pub fn pause(ctx: Context<SetPaused>) -> Result<()> {
        ctx.accounts.config.paused = true;
        emit!(ProgramPaused { paused: true });
        Ok(())
    }

    pub fn unpause(ctx: Context<SetPaused>) -> Result<()> {
        ctx.accounts.config.paused = false;
        emit!(ProgramPaused { paused: false });
        Ok(())
    }
}

// ── Accounts (spec §13) ─────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub paused: bool,
    pub version: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Venue {
    pub venue_id_hash: [u8; 32],
    pub venue_authority: Pubkey,
    pub vault_authority: Pubkey,
    pub active: bool,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SettlementRecord {
    pub payment_id_hash: [u8; 32],
    pub allocation_hash: [u8; 32],
    pub venue: Pubkey,
    pub worker_wallet: Pubkey,
    pub amount: u64,
    pub status: u8,
    pub settled_at: i64,
    pub correction_reference: [u8; 32],
    pub bump: u8,
}

// ── Instruction contexts ────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(venue_id_hash: [u8; 32])]
pub struct RegisterVenue<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = admin,
        space = 8 + Venue::INIT_SPACE,
        seeds = [VENUE_SEED, venue_id_hash.as_ref()],
        bump
    )]
    pub venue: Account<'info, Venue>,
    #[account(mut, address = config.admin @ SpError::Unauthorized)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeVenueVault<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(seeds = [VENUE_SEED, venue.venue_id_hash.as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    /// CHECK: data-less PDA; only used as the vault token account authority
    #[account(seeds = [VAULT_AUTHORITY_SEED, venue.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ SpError::InvalidMint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority
    )]
    pub venue_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(payment_id_hash: [u8; 32])]
pub struct SettlePayout<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(seeds = [VENUE_SEED, venue.venue_id_hash.as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    // Check 3 — signer must be the registered venue authority
    #[account(mut, address = venue.venue_authority @ SpError::Unauthorized)]
    pub venue_authority: Signer<'info>,
    /// CHECK: data-less PDA vault authority (check 4 via seeds)
    #[account(seeds = [VAULT_AUTHORITY_SEED, venue.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    // Check 5 — vault must be the canonical ATA of (usdc_mint, vault_authority)
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault_authority
    )]
    pub venue_vault: Account<'info, TokenAccount>,
    /// CHECK: worker payout wallet; owner of the destination ATA (check 6)
    pub worker_wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = venue_authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = worker_wallet
    )]
    pub worker_token_account: Account<'info, TokenAccount>,
    // Check 7 — init fails when the record already exists (duplicate payment)
    #[account(
        init,
        payer = venue_authority,
        space = 8 + SettlementRecord::INIT_SPACE,
        seeds = [SETTLEMENT_SEED, payment_id_hash.as_ref()],
        bump
    )]
    pub settlement_record: Account<'info, SettlementRecord>,
    // Check 5 — mint pinned to config
    #[account(address = config.usdc_mint @ SpError::InvalidMint)]
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(payment_id_hash: [u8; 32])]
pub struct MarkCorrected<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(seeds = [VENUE_SEED, venue.venue_id_hash.as_ref()], bump = venue.bump)]
    pub venue: Account<'info, Venue>,
    #[account(
        mut,
        seeds = [SETTLEMENT_SEED, payment_id_hash.as_ref()],
        bump = settlement_record.bump,
        constraint = settlement_record.venue == venue.key() @ SpError::VenueMismatch
    )]
    pub settlement_record: Account<'info, SettlementRecord>,
    // venue authority or protocol admin may mark corrections
    #[account(
        constraint = authority.key() == venue.venue_authority
            || authority.key() == config.admin @ SpError::Unauthorized
    )]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(address = config.admin @ SpError::Unauthorized)]
    pub admin: Signer<'info>,
}

// ── Events (spec §15) ───────────────────────────────────────────────────────

#[event]
pub struct PayoutSettled {
    pub payment_id_hash: [u8; 32],
    pub allocation_hash: [u8; 32],
    pub venue: Pubkey,
    pub worker_wallet: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VenueRegistered {
    pub venue: Pubkey,
    pub venue_id_hash: [u8; 32],
    pub venue_authority: Pubkey,
}

#[event]
pub struct VaultInitialized {
    pub venue: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct SettlementCorrected {
    pub payment_id_hash: [u8; 32],
    pub correction_hash: [u8; 32],
    pub disputed: bool,
}

#[event]
pub struct ProgramPaused {
    pub paused: bool,
}

// ── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum SpError {
    #[msg("Protocol is paused")]
    ProtocolPaused,
    #[msg("Venue is not active")]
    VenueInactive,
    #[msg("Unauthorized signer")]
    Unauthorized,
    #[msg("Mint does not match protocol USDC mint")]
    InvalidMint,
    #[msg("Vault balance is insufficient")]
    InsufficientVaultBalance,
    #[msg("Allocation hash must not be zero")]
    ZeroAllocationHash,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Settlement record does not belong to this venue")]
    VenueMismatch,
}
