use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    sysvar::instructions::{load_instruction_at_checked, ID as IX_SYSVAR_ID},
};
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("Cook1e9wZp7vR9z8w9bZq6d2hF3gB2qK8L5vE7jM4x1");

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const STAKE_SEED: &[u8] = b"stake";
pub const MINT_SEED: &[u8] = b"mint";
pub const PRECISION_FACTOR: u128 = 1_000_000_000_000; // 1e12 for fixed point math

#[program]
pub mod cookie_agent {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        cookie_oracle_authority: Pubkey,
        fee_basis_points: u16,
    ) -> Result<()> {
        require!(fee_basis_points <= 1000, CookieAgentError::FeeTooHigh); // Max 10%
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.cookie_oracle_authority = cookie_oracle_authority;
        config.fee_basis_points = fee_basis_points;
        config.total_agents = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn initialize_agent_vault(
        ctx: Context<InitializeAgentVault>,
        agent_id: String,
        initial_mindshare: u64,
        base_price_lamports: u64,
    ) -> Result<()> {
        require!(agent_id.len() <= 64, CookieAgentError::AgentIdTooLong);
        require!(base_price_lamports > 0, CookieAgentError::InvalidPrice);

        let vault = &mut ctx.accounts.vault;
        vault.agent_id = agent_id;
        vault.creator = ctx.accounts.creator.key();
        vault.mint = ctx.accounts.agent_token_mint.key();
        vault.payment_mint = ctx.accounts.payment_mint.key();
        vault.escrow_account = ctx.accounts.vault_escrow.key();
        vault.mindshare_score = initial_mindshare;
        vault.base_price = base_price_lamports;
        vault.total_staked_tokens = 0;
        vault.accumulated_reward_per_share = 0;
        vault.last_update_ts = Clock::get()?.unix_timestamp;
        vault.bump = ctx.bumps.vault;
        vault.mint_bump = ctx.bumps.agent_token_mint;
        vault.escrow_bump = ctx.bumps.vault_escrow;

        let config = &mut ctx.accounts.config;
        config.total_agents = config.total_agents.checked_add(1).ok_or(CookieAgentError::MathOverflow)?;

        Ok(())
    }

    pub fn update_mindshare(
        ctx: Context<UpdateMindshare>,
        agent_id: String,
        new_mindshare: u64,
        timestamp: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            timestamp <= clock.unix_timestamp && timestamp >= clock.unix_timestamp - 300,
            CookieAgentError::StaleTimestamp
        );

        // Introspect Ed25519 PreCompile signature verification from sysvar instructions
        let ix_sysvar_account = &ctx.accounts.sysvar_instructions;
        let current_ix_index = anchor_lang::solana_program::sysvar::instructions::load_current_index_checked(
            &ix_sysvar_account.to_account_info(),
        )?;
        require!(current_ix_index > 0, CookieAgentError::MissingEd25519Instruction);

        let prev_ix: Instruction = load_instruction_at_checked(
            (current_ix_index - 1) as usize,
            &ix_sysvar_account.to_account_info(),
        )?;

        // Verify that the preceding instruction was the Ed25519 SigVerify precompile
        require!(
            prev_ix.program_id == anchor_lang::solana_program::ed25519_program::ID,
            CookieAgentError::InvalidInstructionOrder
        );

        // Security assertion: Ensure the pubkey signing the instruction matches the trusted Cookie Oracle
        let oracle_pubkey = ctx.accounts.config.cookie_oracle_authority;
        let oracle_bytes = oracle_pubkey.to_bytes();
        
        // Data format of Ed25519 Program Instruction payload contains the 32-byte public key at offset 16..48
        require!(prev_ix.data.len() >= 48, CookieAgentError::MalformedEd25519Data);
        let extracted_pubkey = &prev_ix.data[16..48];
        require!(extracted_pubkey == oracle_bytes, CookieAgentError::UnauthorizedOracleSigner);

        let vault = &mut ctx.accounts.vault;
        vault.mindshare_score = new_mindshare;
        vault.last_update_ts = clock.unix_timestamp;

        emit!(MindshareUpdated {
            agent_id,
            new_mindshare,
            updated_at: vault.last_update_ts,
        });

        Ok(())
    }

    pub fn stake_agent(ctx: Context<StakeAgent>, amount_payment: u64) -> Result<()> {
        require!(amount_payment > 0, CookieAgentError::ZeroDeposit);

        let vault = &ctx.accounts.vault;
        
        // Dynamic bonding pricing based on base_price and mindshare:
        // effective_price = base_price * (1 + mindshare / 100_000)
        let mindshare_multiplier = (vault.mindshare_score as u128)
            .checked_mul(PRECISION_FACTOR)
            .ok_or(CookieAgentError::MathOverflow)?
            .checked_div(100_000)
            .ok_or(CookieAgentError::MathOverflow)?;

        let price_scaler = PRECISION_FACTOR
            .checked_add(mindshare_multiplier)
            .ok_or(CookieAgentError::MathOverflow)?;

        let unit_price = (vault.base_price as u128)
            .checked_mul(price_scaler)
            .ok_or(CookieAgentError::MathOverflow)?
            .checked_div(PRECISION_FACTOR)
            .ok_or(CookieAgentError::MathOverflow)?;

        let tokens_to_mint = (amount_payment as u128)
            .checked_mul(PRECISION_FACTOR)
            .ok_or(CookieAgentError::MathOverflow)?
            .checked_div(unit_price)
            .ok_or(CookieAgentError::MathOverflow)? as u64;

        require!(tokens_to_mint > 0, CookieAgentError::DepositAmountTooSmall);

        // Deposit payment tokens to vault escrow
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_payment_account.to_account_info(),
                to: ctx.accounts.vault_escrow.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount_payment)?;

        // Mint AMT to user
        let agent_id_bytes = vault.agent_id.as_bytes();
        let seeds = &[
            VAULT_SEED,
            agent_id_bytes,
            &[vault.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let mint_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.agent_token_mint.to_account_info(),
                to: ctx.accounts.user_agent_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::mint_to(mint_ctx, tokens_to_mint)?;

        // Update stake state and settle pending rewards before balance mutation
        let user_stake = &mut ctx.accounts.user_stake;
        if user_stake.staked_amount > 0 {
            let pending_rewards = (user_stake.staked_amount as u128)
                .checked_mul(vault.accumulated_reward_per_share)
                .ok_or(CookieAgentError::MathOverflow)?
                .checked_div(PRECISION_FACTOR)
                .ok_or(CookieAgentError::MathOverflow)?
                .checked_sub(user_stake.reward_debt)
                .ok_or(CookieAgentError::MathOverflow)? as u64;

            user_stake.unclaimed_rewards = user_stake
                .unclaimed_rewards
                .checked_add(pending_rewards)
                .ok_or(CookieAgentError::MathOverflow)?;
        }

        user_stake.user = ctx.accounts.user.key();
        user_stake.agent_vault = vault.key();
        user_stake.staked_amount = user_stake
            .staked_amount
            .checked_add(tokens_to_mint)
            .ok_or(CookieAgentError::MathOverflow)?;
        
        user_stake.reward_debt = (user_stake.staked_amount as u128)
            .checked_mul(vault.accumulated_reward_per_share)
            .ok_or(CookieAgentError::MathOverflow)?
            .checked_div(PRECISION_FACTOR)
            .ok_or(CookieAgentError::MathOverflow)?;

        let vault_mut = &mut ctx.accounts.vault;
        vault_mut.total_staked_tokens = vault_mut
            .total_staked_tokens
            .checked_add(tokens_to_mint)
            .ok_or(CookieAgentError::MathOverflow)?;

        emit!(AgentStaked {
            agent_id: vault_mut.agent_id.clone(),
            user: ctx.accounts.user.key(),
            paid_amount: amount_payment,
            minted_amt: tokens_to_mint,
        });

        Ok(())
    }

    pub fn distribute_yield(ctx: Context<DistributeYield>, yield_amount: u64) -> Result<()> {
        require!(yield_amount > 0, CookieAgentError::ZeroYieldAmount);
        let vault = &mut ctx.accounts.vault;
        require!(vault.total_staked_tokens > 0, CookieAgentError::NoStakersActive);

        // Protocol fee deduction
        let config = &ctx.accounts.config;
        let fee = (yield_amount as u128)
            .checked_mul(config.fee_basis_points as u128)
            .ok_or(CookieAgentError::MathOverflow)?
            .checked_div(10000)
            .ok_or(CookieAgentError::MathOverflow)? as u64;

        let distributable_amount = yield_amount.checked_sub(fee).ok_or(CookieAgentError::MathOverflow)?;

        // Transfer yield into vault reward escrow
        let transfer_fee_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.distributor_payment_account.to_account_info(),
                to: ctx.accounts.admin_treasury.to_account_info(),
                authority: ctx.accounts.distributor.to_account_info(),
            },
        );
        token::transfer(transfer_fee_ctx, fee)?;

        let transfer_yield_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.distributor_payment_account.to_account_info(),
                to: ctx.accounts.vault_escrow.to_account_info(),
                authority: ctx.accounts.distributor.to_account_info(),
            },
        );
        token::transfer(transfer_yield_ctx, distributable_amount)?;

        // Update reward index: delta = (distributable * PRECISION_FACTOR) / total_staked_tokens
        let delta_accumulator = (distributable_amount as u128)
            .checked_mul(PRECISION_FACTOR)
            .ok_or(CookieAgentError::MathOverflow)?
            .checked_div(vault.total_staked_tokens as u128)
            .ok_or(CookieAgentError::MathOverflow)?;

        vault.accumulated_reward_per_share = vault
            .accumulated_reward_per_share
            .checked_add(delta_accumulator)
            .ok_or(CookieAgentError::MathOverflow)?;

        emit!(YieldDistributed {
            agent_id: vault.agent_id.clone(),
            yield_distributed: distributable_amount,
            fee_deducted: fee,
        });

        Ok(())
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        let vault = &ctx.accounts.vault;
        let user_stake = &mut ctx.accounts.user_stake;

        let current_accumulated = (user_stake.staked_amount as u128)
            .checked_mul(vault.accumulated_reward_per_share)
            .ok_or(CookieAgentError::MathOverflow)?
            .checked_div(PRECISION_FACTOR)
            .ok_or(CookieAgentError::MathOverflow)?;

        let pending_from_index = current_accumulated
            .checked_sub(user_stake.reward_debt)
            .ok_or(CookieAgentError::MathOverflow)? as u64;

        let total_claimable = user_stake
            .unclaimed_rewards
            .checked_add(pending_from_index)
            .ok_or(CookieAgentError::MathOverflow)?;

        require!(total_claimable > 0, CookieAgentError::NoRewardsToClaim);

        user_stake.unclaimed_rewards = 0;
        user_stake.reward_debt = current_accumulated;

        let agent_id_bytes = vault.agent_id.as_bytes();
        let seeds = &[
            VAULT_SEED,
            agent_id_bytes,
            &[vault.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_escrow.to_account_info(),
                to: ctx.accounts.user_payment_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, total_claimable)?;

        emit!(RewardsClaimed {
            agent_id: vault.agent_id.clone(),
            user: ctx.accounts.user.key(),
            amount: total_claimable,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub mod initialize_agent_vault_accounts {
    use super::*;

    #[derive(Accounts)]
    #[instruction(agent_id: String)]
    pub struct InitializeAgentVault<'info> {
        #[account(
            init,
            payer = creator,
            space = 8 + AgentVault::INIT_SPACE,
            seeds = [VAULT_SEED, agent_id.as_bytes()],
            bump
        )]
        pub vault: Account<'info, AgentVault>,

        #[account(
            init,
            payer = creator,
            seeds = [MINT_SEED, agent_id.as_bytes()],
            bump,
            mint::decimals = 6,
            mint::authority = vault,
        )]
        pub agent_token_mint: Account<'info, Mint>,

        pub payment_mint: Account<'info, Mint>,

        #[account(
            init,
            payer = creator,
            seeds = [ESCROW_SEED, agent_id.as_bytes()],
            bump,
            token::mint = payment_mint,
            token::authority = vault,
        )]
        pub vault_escrow: Account<'info, TokenAccount>,

        #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
        pub config: Account<'info, GlobalConfig>,

        #[account(mut)]
        pub creator: Signer<'info>,
        pub system_program: Program<'info, System>,
        pub token_program: Program<'info, Token>,
        pub rent: Sysvar<'info, Rent>,
    }
}
pub use initialize_agent_vault_accounts::*;

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct UpdateMindshare<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [VAULT_SEED, agent_id.as_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AgentVault>,
    /// CHECK: Validated as Solana instruction sysvar
    #[account(address = IX_SYSVAR_ID @ CookieAgentError::InvalidSysvar)]
    pub sysvar_instructions: AccountInfo<'info>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct StakeAgent<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.agent_id.as_bytes()],
        bump = vault.bump,
        has_one = payment_mint @ CookieAgentError::InvalidPaymentMint,
        has_one = escrow_account @ CookieAgentError::InvalidEscrowAccount,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        seeds = [MINT_SEED, vault.agent_id.as_bytes()],
        bump = vault.mint_bump,
    )]
    pub agent_token_mint: Account<'info, Mint>,

    pub payment_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, vault.agent_id.as_bytes()],
        bump = vault.escrow_bump,
    )]
    pub vault_escrow: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserStakePosition::INIT_SPACE,
        seeds = [STAKE_SEED, vault.agent_id.as_bytes(), user.key().as_ref()],
        bump
    )]
    pub user_stake: Account<'info, UserStakePosition>,

    #[account(
        mut,
        constraint = user_payment_account.owner == user.key() @ CookieAgentError::UnauthorizedAccountOwner,
        constraint = user_payment_account.mint == payment_mint.key() @ CookieAgentError::InvalidPaymentMint,
    )]
    pub user_payment_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_agent_token_account.owner == user.key() @ CookieAgentError::UnauthorizedAccountOwner,
        constraint = user_agent_token_account.mint == agent_token_mint.key() @ CookieAgentError::InvalidMint,
    )]
    pub user_agent_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DistributeYield<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.agent_id.as_bytes()],
        bump = vault.bump,
        has_one = escrow_account @ CookieAgentError::InvalidEscrowAccount,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, vault.agent_id.as_bytes()],
        bump = vault.escrow_bump,
    )]
    pub vault_escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_treasury.owner == config.admin @ CookieAgentError::UnauthorizedTreasury,
    )]
    pub admin_treasury: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = distributor_payment_account.owner == distributor.key() @ CookieAgentError::UnauthorizedAccountOwner,
    )]
    pub distributor_payment_account: Account<'info, TokenAccount>,

    pub distributor: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(
        seeds = [VAULT_SEED, vault.agent_id.as_bytes()],
        bump = vault.bump,
        has_one = escrow_account @ CookieAgentError::InvalidEscrowAccount,
    )]
    pub vault: Account<'info, AgentVault>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, vault.agent_id.as_bytes()],
        bump = vault.escrow_bump,
    )]
    pub vault_escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [STAKE_SEED, vault.agent_id.as_bytes(), user.key().as_ref()],
        bump = user_stake.bump,
        has_one = user @ CookieAgentError::UnauthorizedAccountOwner,
    )]
    pub user_stake: Account<'info, UserStakePosition>,

    #[account(
        mut,
        constraint = user_payment_account.owner == user.key() @ CookieAgentError::UnauthorizedAccountOwner,
        constraint = user_payment_account.mint == vault.payment_mint @ CookieAgentError::InvalidPaymentMint,
    )]
    pub user_payment_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub cookie_oracle_authority: Pubkey,
    pub fee_basis_points: u16,
    pub total_agents: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AgentVault {
    #[max_len(64)]
    pub agent_id: String,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub payment_mint: Pubkey,
    pub escrow_account: Pubkey,
    pub mindshare_score: u64,
    pub base_price: u64,
    pub total_staked_tokens: u64,
    pub accumulated_reward_per_share: u128,
    pub last_update_ts: i64,
    pub bump: u8,
    pub mint_bump: u8,
    pub escrow_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserStakePosition {
    pub user: Pubkey,
    pub agent_vault: Pubkey,
    pub staked_amount: u64,
    pub reward_debt: u128,
    pub unclaimed_rewards: u64,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct MindshareUpdated {
    pub agent_id: String,
    pub new_mindshare: u64,
    pub updated_at: i64,
}

#[event]
pub struct AgentStaked {
    pub agent_id: String,
    pub user: Pubkey,
    pub paid_amount: u64,
    pub minted_amt: u64,
}

#[event]
pub struct YieldDistributed {
    pub agent_id: String,
    pub yield_distributed: u64,
    pub fee_deducted: u64,
}

#[event]
pub struct RewardsClaimed {
    pub agent_id: String,
    pub user: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum CookieAgentError {
    #[msg("Fee basis points exceeds ceiling limit of 1000 (10%)")]
    FeeTooHigh,
    #[msg("Agent ID string length exceeds maximum 64 characters")]
    AgentIdTooLong,
    #[msg("Price must be strictly non-zero")]
    InvalidPrice,
    #[msg("Arithmetic overflow detected in checked math calculation")]
    MathOverflow,
    #[msg("Mindshare timestamp is stale or from future block")]
    StaleTimestamp,
    #[msg("Missing required Ed25519 signature verification instruction")]
    MissingEd25519Instruction,
    #[msg("Preceding instruction is not an Ed25519 program verify call")]
    InvalidInstructionOrder,
    #[msg("Malformed Ed25519 instruction data buffer")]
    MalformedEd25519Data,
    #[msg("Ed25519 signature authority does not match Cookie Oracle Authority")]
    UnauthorizedOracleSigner,
    #[msg("Zero deposit payment received")]
    ZeroDeposit,
    #[msg("Deposit amount yields zero Agent Mindshare Tokens")]
    DepositAmountTooSmall,
    #[msg("Zero yield distribution passed")]
    ZeroYieldAmount,
    #[msg("Cannot distribute yield to an agent vault with zero stakers")]
    NoStakersActive,
    #[msg("No pending rewards available to claim")]
    NoRewardsToClaim,
    #[msg("Supplied instruction sysvar address is invalid")]
    InvalidSysvar,
    #[msg("Target payment mint does not match vault specifications")]
    InvalidPaymentMint,
    #[msg("Target escrow account PDA does not match vault state")]
    InvalidEscrowAccount,
    #[msg("Unauthorized account owner supplied")]
    UnauthorizedAccountOwner,
    #[msg("Invalid AMT mint address provided")]
    InvalidMint,
    #[msg("Unauthorized treasury token account supplied")]
    UnauthorizedTreasury,
}