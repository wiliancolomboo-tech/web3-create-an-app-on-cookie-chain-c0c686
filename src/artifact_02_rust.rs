use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Cook1eJar11111111111111111111111111111111111");

pub const CONFIG_SEED: &[u8] = b"config";
pub const AGENT_SEED: &[u8] = b"agent";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const ESCROW_VAULT_SEED: &[u8] = b"escrow_vault";
pub const STAKING_VAULT_SEED: &[u8] = b"staking_vault";
pub const EPOCH_SEED: &[u8] = b"epoch";

pub const MAX_FEE_BPS: u16 = 1000; // Maximum 10% protocol fee
pub const BPS_DENOMINATOR: u128 = 10000;
pub const MIN_STAKE_AMOUNT: u64 = 1_000_000; // 1 Token with 6 decimals

#[program]
pub mod cookie_jar {
    use super::*;

    /// Initializes the global configuration of the Cookie Jar protocol.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        fee_bps: u16,
        oracle_signer: Pubkey,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, CookieJarError::FeeTooHigh);
        
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.oracle_signer = oracle_signer;
        config.protocol_fee_bps = fee_bps;
        config.total_agents_registered = 0;
        config.total_bounties_created = 0;
        config.bump = ctx.bumps.config;

        emit!(ProtocolInitialized {
            admin: config.admin,
            oracle_signer,
            fee_bps,
        });

        Ok(())
    }

    /// Registers an autonomous agent with metadata and initializes its staking account.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_id: String,
        metadata_uri: String,
    ) -> Result<()> {
        require!(agent_id.len() <= 64, CookieJarError::IdentifierTooLong);
        require!(metadata_uri.len() <= 128, CookieJarError::IdentifierTooLong);

        let agent = &mut ctx.accounts.agent_record;
        let config = &mut ctx.accounts.config;

        agent.owner = ctx.accounts.agent_owner.key();
        agent.mint = ctx.accounts.staking_mint.key();
        agent.agent_id = agent_id;
        agent.metadata_uri = metadata_uri;
        agent.mindshare_score = 0;
        agent.last_epoch_updated = 0;
        agent.staked_amount = 0;
        agent.slashed_amount = 0;
        agent.is_active = true;
        agent.bump = ctx.bumps.agent_record;
        agent.vault_bump = ctx.bumps.staking_vault;

        config.total_agents_registered = config
            .total_agents_registered
            .checked_add(1)
            .ok_or(CookieJarError::MathOverflow)?;

        emit!(AgentRegistered {
            agent_pubkey: agent.key(),
            owner: agent.owner,
            agent_id: agent.agent_id.clone(),
        });

        Ok(())
    }

    /// Stakes collateral for an AI agent to establish economic security.
    pub fn stake_collateral(ctx: Context<StakeCollateral>, amount: u64) -> Result<()> {
        require!(amount >= MIN_STAKE_AMOUNT, CookieJarError::StakeTooLow);

        let cpi_accounts = Transfer {
            from: ctx.accounts.funder_token_account.to_account_info(),
            to: ctx.accounts.staking_vault.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount)?;

        let agent = &mut ctx.accounts.agent_record;
        agent.staked_amount = agent
            .staked_amount
            .checked_add(amount)
            .ok_or(CookieJarError::MathOverflow)?;

        emit!(AgentStaked {
            agent: agent.key(),
            amount,
            total_staked: agent.staked_amount,
        });

        Ok(())
    }

    /// Creates a sponsor-funded campaign escrow targeting AI agent mindshare.
    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        escrow_id: u64,
        amount: u64,
        target_epoch: u64,
    ) -> Result<()> {
        require!(amount > 0, CookieJarError::ZeroAmount);
        
        // Transfer bounty tokens to escrow vault PDA
        let cpi_accounts = Transfer {
            from: ctx.accounts.sponsor_token_account.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.sponsor.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
            amount,
        )?;

        let escrow = &mut ctx.accounts.bounty_escrow;
        let config = &mut ctx.accounts.config;

        escrow.sponsor = ctx.accounts.sponsor.key();
        escrow.escrow_id = escrow_id;
        escrow.mint = ctx.accounts.mint.key();
        escrow.total_amount = amount;
        escrow.remaining_amount = amount;
        escrow.target_epoch = target_epoch;
        escrow.is_settled = false;
        escrow.bump = ctx.bumps.bounty_escrow;
        escrow.vault_bump = ctx.bumps.escrow_vault;

        config.total_bounties_created = config
            .total_bounties_created
            .checked_add(1)
            .ok_or(CookieJarError::MathOverflow)?;

        emit!(EscrowCreated {
            escrow_id,
            sponsor: escrow.sponsor,
            amount,
            target_epoch,
        });

        Ok(())
    }

    /// Oracle submission of epoch mindshare telemetry.
    pub fn submit_mindshare_epoch(
        ctx: Context<SubmitMindshareEpoch>,
        epoch_id: u64,
        total_epoch_mindshare: u64,
        agent_scores: Vec<AgentMindshareEntry>,
    ) -> Result<()> {
        require!(
            ctx.accounts.oracle_authority.key() == ctx.accounts.config.oracle_signer,
            CookieJarError::UnauthorizedOracle
        );
        require!(total_epoch_mindshare > 0, CookieJarError::InvalidTelemetry);

        let epoch = &mut ctx.accounts.epoch_state;
        require!(!epoch.finalized, CookieJarError::EpochAlreadyFinalized);

        epoch.epoch_id = epoch_id;
        epoch.total_mindshare = total_epoch_mindshare;
        epoch.finalized = true;
        epoch.bump = ctx.bumps.epoch_state;

        emit!(EpochFinalized {
            epoch_id,
            total_mindshare: total_epoch_mindshare,
            entries_count: agent_scores.len() as u32,
        });

        Ok(())
    }

    /// Updates an individual agent's validated mindshare score for a finalized epoch.
    pub fn update_agent_metric(
        ctx: Context<UpdateAgentMetric>,
        epoch_id: u64,
        mindshare_score: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.oracle_authority.key() == ctx.accounts.config.oracle_signer,
            CookieJarError::UnauthorizedOracle
        );
        let epoch = &ctx.accounts.epoch_state;
        require!(epoch.finalized, CookieJarError::EpochNotFinalized);
        require!(epoch.epoch_id == epoch_id, CookieJarError::EpochMismatch);

        let agent = &mut ctx.accounts.agent_record;
        require!(agent.is_active, CookieJarError::AgentInactive);

        agent.mindshare_score = mindshare_score;
        agent.last_epoch_updated = epoch_id;

        emit!(AgentScoreUpdated {
            agent: agent.key(),
            epoch_id,
            mindshare_score,
        });

        Ok(())
    }

    /// Settles bounty payout to an agent based on verified mindshare fraction.
    pub fn settle_agent_bounty(ctx: Context<SettleAgentBounty>) -> Result<()> {
        let escrow = &mut ctx.accounts.bounty_escrow;
        let epoch = &ctx.accounts.epoch_state;
        let agent = &ctx.accounts.agent_record;
        let config = &ctx.accounts.config;

        require!(!escrow.is_settled, CookieJarError::EscrowAlreadySettled);
        require!(epoch.finalized, CookieJarError::EpochNotFinalized);
        require!(escrow.target_epoch == epoch.epoch_id, CookieJarError::EpochMismatch);
        require!(agent.last_epoch_updated == epoch.epoch_id, CookieJarError::TelemetryStale);
        require!(agent.is_active, CookieJarError::AgentInactive);
        require!(epoch.total_mindshare > 0, CookieJarError::InvalidTelemetry);

        // Calculate Pro-Rata Share: Reward = (RemainingEscrow * AgentMindshare) / TotalMindshare
        let gross_reward = (escrow.remaining_amount as u128)
            .checked_mul(agent.mindshare_score as u128)
            .ok_or(CookieJarError::MathOverflow)?
            .checked_div(epoch.total_mindshare as u128)
            .ok_or(CookieJarError::MathOverflow)? as u64;

        require!(gross_reward > 0, CookieJarError::RewardTooSmall);

        // Protocol fee calculation
        let fee_amount = (gross_reward as u128)
            .checked_mul(config.protocol_fee_bps as u128)
            .ok_or(CookieJarError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR)
            .ok_or(CookieJarError::MathOverflow)? as u64;

        let net_agent_payout = gross_reward
            .checked_sub(fee_amount)
            .ok_or(CookieJarError::MathOverflow)?;

        // Execute Escrow Vault transfers using Escrow PDA signer seeds
        let sponsor_key = escrow.sponsor;
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let escrow_seeds = &[
            ESCROW_SEED,
            sponsor_key.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.bump],
        ];
        let signer = &[&escrow_seeds[..]];

        // 1. Transfer net payout to agent owner wallet
        let cpi_agent_transfer = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.agent_payout_account.to_account_info(),
            authority: ctx.accounts.bounty_escrow.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_agent_transfer,
                signer,
            ),
            net_agent_payout,
        )?;

        // 2. Transfer fee to protocol treasury
        if fee_amount > 0 {
            let cpi_fee_transfer = Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.protocol_treasury_vault.to_account_info(),
                authority: ctx.accounts.bounty_escrow.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_fee_transfer,
                    signer,
                ),
                fee_amount,
            )?;
        }

        escrow.remaining_amount = escrow
            .remaining_amount
            .checked_sub(gross_reward)
            .ok_or(CookieJarError::MathOverflow)?;

        if escrow.remaining_amount == 0 {
            escrow.is_settled = true;
        }

        emit!(BountySettled {
            escrow: escrow.key(),
            agent: agent.key(),
            gross_amount: gross_reward,
            fee: fee_amount,
            net_amount: net_agent_payout,
        });

        Ok(())
    }

    /// Slashes an agent's staked bond upon detected malicious behavior (e.g., sybil manipulation).
    pub fn slash_faulty_agent(
        ctx: Context<SlashFaultyAgent>,
        slash_amount: u64,
        reason_code: u8,
    ) -> Result<()> {
        require!(
            ctx.accounts.oracle_authority.key() == ctx.accounts.config.oracle_signer,
            CookieJarError::UnauthorizedOracle
        );

        let agent = &mut ctx.accounts.agent_record;
        require!(agent.staked_amount >= slash_amount, CookieJarError::InsufficientStake);

        let agent_owner = agent.owner;
        let staking_seeds = &[
            AGENT_SEED,
            agent_owner.as_ref(),
            &[agent.bump],
        ];
        let signer = &[&staking_seeds[..]];

        let cpi_slash = Transfer {
            from: ctx.accounts.staking_vault.to_account_info(),
            to: ctx.accounts.protocol_treasury_vault.to_account_info(),
            authority: ctx.accounts.agent_record.to_account_info(),
        };

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_slash,
                signer,
            ),
            slash_amount,
        )?;

        agent.staked_amount = agent
            .staked_amount
            .checked_sub(slash_amount)
            .ok_or(CookieJarError::MathOverflow)?;
        agent.slashed_amount = agent
            .slashed_amount
            .checked_add(slash_amount)
            .ok_or(CookieJarError::MathOverflow)?;

        if agent.staked_amount < MIN_STAKE_AMOUNT {
            agent.is_active = false;
        }

        emit!(AgentSlashed {
            agent: agent.key(),
            slashed_amount: slash_amount,
            reason_code,
            is_active: agent.is_active,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// INSTRUCTION CONTEXT ACCOUNTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub agent_owner: Signer<'info>,

    #[account(
        init,
        payer = agent_owner,
        space = 8 + AgentRecord::INIT_SPACE,
        seeds = [AGENT_SEED, agent_owner.key().as_ref()],
        bump
    )]
    pub agent_record: Account<'info, AgentRecord>,

    pub staking_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = agent_owner,
        seeds = [STAKING_VAULT_SEED, agent_record.key().as_ref()],
        bump,
        token::mint = staking_mint,
        token::authority = agent_record
    )]
    pub staking_vault: Account<'info, TokenAccount>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct StakeCollateral<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        mut,
        seeds = [AGENT_SEED, agent_record.owner.as_ref()],
        bump = agent_record.bump
    )]
    pub agent_record: Account<'info, AgentRecord>,

    #[account(
        mut,
        seeds = [STAKING_VAULT_SEED, agent_record.key().as_ref()],
        bump = agent_record.vault_bump
    )]
    pub staking_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = funder_token_account.owner == funder.key(),
        constraint = funder_token_account.mint == agent_record.mint
    )]
    pub funder_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = sponsor,
        space = 8 + BountyEscrow::INIT_SPACE,
        seeds = [ESCROW_SEED, sponsor.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub bounty_escrow: Account<'info, BountyEscrow>,

    #[account(
        init,
        payer = sponsor,
        seeds = [ESCROW_VAULT_SEED, bounty_escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = bounty_escrow
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sponsor_token_account.owner == sponsor.key(),
        constraint = sponsor_token_account.mint == mint.key()
    )]
    pub sponsor_token_account: Account<'info, TokenAccount>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct SubmitMindshareEpoch<'info> {
    #[account(mut)]
    pub oracle_authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = oracle_authority,
        space = 8 + EpochState::INIT_SPACE,
        seeds = [EPOCH_SEED, &epoch_id.to_le_bytes()],
        bump
    )]
    pub epoch_state: Account<'info, EpochState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAgentMetric<'info> {
    pub oracle_authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        seeds = [EPOCH_SEED, &epoch_state.epoch_id.to_le_bytes()],
        bump = epoch_state.bump
    )]
    pub epoch_state: Account<'info, EpochState>,

    #[account(
        mut,
        seeds = [AGENT_SEED, agent_record.owner.as_ref()],
        bump = agent_record.bump
    )]
    pub agent_record: Account<'info, AgentRecord>,
}

#[derive(Accounts)]
pub struct SettleAgentBounty<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, bounty_escrow.sponsor.as_ref(), &bounty_escrow.escrow_id.to_le_bytes()],
        bump = bounty_escrow.bump
    )]
    pub bounty_escrow: Account<'info, BountyEscrow>,

    #[account(
        mut,
        seeds = [ESCROW_VAULT_SEED, bounty_escrow.key().as_ref()],
        bump = bounty_escrow.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        seeds = [EPOCH_SEED, &epoch_state.epoch_id.to_le_bytes()],
        bump = epoch_state.bump
    )]
    pub epoch_state: Account<'info, EpochState>,

    #[account(
        seeds = [AGENT_SEED, agent_record.owner.as_ref()],
        bump = agent_record.bump
    )]
    pub agent_record: Account<'info, AgentRecord>,

    #[account(
        mut,
        constraint = agent_payout_account.owner == agent_record.owner,
        constraint = agent_payout_account.mint == bounty_escrow.mint
    )]
    pub agent_payout_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = protocol_treasury_vault.mint == bounty_escrow.mint
    )]
    pub protocol_treasury_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SlashFaultyAgent<'info> {
    pub oracle_authority: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [AGENT_SEED, agent_record.owner.as_ref()],
        bump = agent_record.bump
    )]
    pub agent_record: Account<'info, AgentRecord>,

    #[account(
        mut,
        seeds = [STAKING_VAULT_SEED, agent_record.key().as_ref()],
        bump = agent_record.vault_bump
    )]
    pub staking_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = protocol_treasury_vault.mint == agent_record.mint
    )]
    pub protocol_treasury_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTURES
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub oracle_signer: Pubkey,
    pub protocol_fee_bps: u16,
    pub total_agents_registered: u64,
    pub total_bounties_created: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AgentRecord {
    pub owner: Pubkey,
    pub mint: Pubkey,
    #[max_len(64)]
    pub agent_id: String,
    #[max_len(128)]
    pub metadata_uri: String,
    pub mindshare_score: u64,
    pub last_epoch_updated: u64,
    pub staked_amount: u64,
    pub slashed_amount: u64,
    pub is_active: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BountyEscrow {
    pub sponsor: Pubkey,
    pub escrow_id: u64,
    pub mint: Pubkey,
    pub total_amount: u64,
    pub remaining_amount: u64,
    pub target_epoch: u64,
    pub is_settled: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EpochState {
    pub epoch_id: u64,
    pub total_mindshare: u64,
    pub finalized: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct AgentMindshareEntry {
    pub agent: Pubkey,
    pub mindshare_score: u64,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct ProtocolInitialized {
    pub admin: Pubkey,
    pub oracle_signer: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct AgentRegistered {
    pub agent_pubkey: Pubkey,
    pub owner: Pubkey,
    pub agent_id: String,
}

#[event]
pub struct AgentStaked {
    pub agent: Pubkey,
    pub amount: u64,
    pub total_staked: u64,
}

#[event]
pub struct EscrowCreated {
    pub escrow_id: u64,
    pub sponsor: Pubkey,
    pub amount: u64,
    pub target_epoch: u64,
}

#[event]
pub struct EpochFinalized {
    pub epoch_id: u64,
    pub total_mindshare: u64,
    pub entries_count: u32,
}

#[event]
pub struct AgentScoreUpdated {
    pub agent: Pubkey,
    pub epoch_id: u64,
    pub mindshare_score: u64,
}

#[event]
pub struct BountySettled {
    pub escrow: Pubkey,
    pub agent: Pubkey,
    pub gross_amount: u64,
    pub fee: u64,
    pub net_amount: u64,
}

#[event]
pub struct AgentSlashed {
    pub agent: Pubkey,
    pub slashed_amount: u64,
    pub reason_code: u8,
    pub is_active: bool,
}

#[error_code]
pub enum CookieJarError {
    #[msg("Protocol fee exceeds maximum allowed basis points (1000 bps)")]
    FeeTooHigh,
    #[msg("Identifier or URI length exceeds maximum boundary")]
    IdentifierTooLong,
    #[msg("Stake amount is below required threshold")]
    StakeTooLow,
    #[msg("Escrow amount cannot be zero")]
    ZeroAmount,
    #[msg("Supplied signer is not authorized as Cookie Oracle authority")]
    UnauthorizedOracle,
    #[msg("Provided telemetry mindshare score is invalid")]
    InvalidTelemetry,
    #[msg("Requested epoch is already finalized")]
    EpochAlreadyFinalized,
    #[msg("Target epoch has not been finalized yet")]
    EpochNotFinalized,
    #[msg("Mismatched epoch identifier provided")]
    EpochMismatch,
    #[msg("AI Agent is currently marked inactive or suspended")]
    AgentInactive,
    #[msg("Agent telemetry is stale for the target settlement epoch")]
    TelemetryStale,
    #[msg("Calculated reward rounds down to zero")]
    RewardTooSmall,
    #[msg("Bounty escrow has already settled all allocations")]
    EscrowAlreadySettled,
    #[msg("Mathematical overflow or division by zero detected")]
    MathOverflow,
    #[msg("Insufficient staked collateral available to execute slash")]
    InsufficientStake,
}