use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked, ID as IX_SYSVAR_ID},
};

declare_id!("CookiEX3M7L99Z1FzP7E3rXQYxV58Z8g6L6rUu44gNn");

pub const GLOBAL_CONFIG_SEED: &[u8] = b"global_config";
pub const AGENT_REGISTRY_SEED: &[u8] = b"agent_registry";
pub const VAULT_RESERVE_SEED: &[u8] = b"vault_reserve";
pub const USER_POSITION_SEED: &[u8] = b"user_position";

pub const MAX_FEE_BPS: u16 = 1000; // 10%
pub const SCALING_FACTOR: u128 = 1_000_000_000; // 1e9 precision

#[program]
pub mod cookie_chain {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        fee_bps: u16,
        oracle_signer: Pubkey,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, CookieError::FeeExceedsMaximum);
        let config = &mut ctx.accounts.global_config;
        config.admin = ctx.accounts.admin.key();
        config.oracle_signer = oracle_signer;
        config.fee_bps = fee_bps;
        config.bump = ctx.bumps.global_config;
        config.total_agents = 0;

        emit!(ProtocolInitialized {
            admin: config.admin,
            oracle_signer,
            fee_bps,
        });
        Ok(())
    }

    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_id: String,
        initial_mindshare: u64,
    ) -> Result<()> {
        require!(agent_id.len() <= 32, CookieError::AgentIdTooLong);
        require!(initial_mindshare > 0, CookieError::InvalidMindshareScore);

        let registry = &mut ctx.accounts.agent_registry;
        registry.creator = ctx.accounts.creator.key();
        registry.agent_id = agent_id.clone();
        registry.mindshare_score = initial_mindshare;
        registry.total_shares = 0;
        registry.reserve_lamports = 0;
        registry.last_update_ts = Clock::get()?.unix_timestamp;
        registry.bump = ctx.bumps.agent_registry;
        registry.vault_bump = ctx.bumps.vault_reserve;

        let config = &mut ctx.accounts.global_config;
        config.total_agents = config.total_agents.checked_add(1).ok_or(CookieError::MathOverflow)?;

        emit!(AgentRegistered {
            agent_id,
            creator: registry.creator,
            initial_mindshare,
        });
        Ok(())
    }

    pub fn update_agent_mindshare(
        ctx: Context<UpdateMindshare>,
        new_mindshare: u64,
        timestamp: i64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            timestamp <= clock.unix_timestamp + 60 && timestamp >= clock.unix_timestamp - 300,
            CookieError::TimestampExpired
        );

        // Security check: Validate Ed25519 signature instruction on Instructions Sysvar
        verify_ed25519_ix(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &ctx.accounts.global_config.oracle_signer.to_bytes(),
            &new_mindshare.to_le_bytes(),
            timestamp,
        )?;

        let registry = &mut ctx.accounts.agent_registry;
        require!(timestamp > registry.last_update_ts, CookieError::StaleDataSubmitted);

        let old_mindshare = registry.mindshare_score;
        registry.mindshare_score = new_mindshare;
        registry.last_update_ts = timestamp;

        emit!(MindshareUpdated {
            agent_id: registry.agent_id.clone(),
            old_mindshare,
            new_mindshare,
            timestamp,
        });

        Ok(())
    }

    pub fn buy_agent_shares(
        ctx: Context<BuyAgentShares>,
        lamports_in: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        require!(lamports_in > 0, CookieError::ZeroAmount);
        let registry = &mut ctx.accounts.agent_registry;
        let config = &ctx.accounts.global_config;

        // Protocol & Creator fee breakdown (total fee_bps / 2 to creator, half to DAO)
        let total_fee = (lamports_in as u128)
            .checked_mul(config.fee_bps as u128)
            .ok_or(CookieError::MathOverflow)?
            .checked_div(10000)
            .ok_or(CookieError::MathOverflow)? as u64;

        let net_deposit = lamports_in
            .checked_sub(total_fee)
            .ok_or(CookieError::MathOverflow)?;

        let creator_fee = total_fee / 2;
        let protocol_fee = total_fee.checked_sub(creator_fee).ok_or(CookieError::MathOverflow)?;

        // Execute dynamic bonding curve pricing calculation
        let shares_to_mint = calculate_purchase_return(
            registry.total_shares,
            registry.reserve_lamports,
            registry.mindshare_score,
            net_deposit,
        )?;

        require!(shares_to_mint >= min_shares_out, CookieError::SlippageExceeded);

        // Route SOL fees & deposit
        if creator_fee > 0 {
            anchor_lang::solana_program::program::invoke(
                &anchor_lang::solana_program::system_instruction::transfer(
                    &ctx.accounts.buyer.key(),
                    &ctx.accounts.creator.key(),
                    creator_fee,
                ),
                &[
                    ctx.accounts.buyer.to_account_info(),
                    ctx.accounts.creator.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        if protocol_fee > 0 {
            anchor_lang::solana_program::program::invoke(
                &anchor_lang::solana_program::system_instruction::transfer(
                    &ctx.accounts.buyer.key(),
                    &ctx.accounts.protocol_treasury.key(),
                    protocol_fee,
                ),
                &[
                    ctx.accounts.buyer.to_account_info(),
                    ctx.accounts.protocol_treasury.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // Transfer net lamports to reserve vault
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.buyer.key(),
                &ctx.accounts.vault_reserve.to_account_info(),
                net_deposit,
            ),
            &[
                ctx.accounts.buyer.to_account_info(),
                ctx.accounts.vault_reserve.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Mutate registry and user balances
        registry.reserve_lamports = registry
            .reserve_lamports
            .checked_add(net_deposit)
            .ok_or(CookieError::MathOverflow)?;
        registry.total_shares = registry
            .total_shares
            .checked_add(shares_to_mint)
            .ok_or(CookieError::MathOverflow)?;

        let user_pos = &mut ctx.accounts.user_position;
        user_pos.shares_held = user_pos
            .shares_held
            .checked_add(shares_to_mint)
            .ok_or(CookieError::MathOverflow)?;
        user_pos.owner = ctx.accounts.buyer.key();
        user_pos.agent_registry = registry.key();

        emit!(SharesPurchased {
            agent_id: registry.agent_id.clone(),
            buyer: ctx.accounts.buyer.key(),
            lamports_spent: lamports_in,
            shares_minted: shares_to_mint,
            reserve_balance: registry.reserve_lamports,
        });

        Ok(())
    }

    pub fn sell_agent_shares(
        ctx: Context<SellAgentShares>,
        shares_in: u64,
        min_lamports_out: u64,
    ) -> Result<()> {
        require!(shares_in > 0, CookieError::ZeroAmount);
        let user_pos = &mut ctx.accounts.user_position;
        require!(user_pos.shares_held >= shares_in, CookieError::InsufficientShares);

        let registry = &mut ctx.accounts.agent_registry;

        // Liquidation value computation
        let gross_lamports_out = calculate_liquidation_return(
            registry.total_shares,
            registry.reserve_lamports,
            registry.mindshare_score,
            shares_in,
        )?;

        let config = &ctx.accounts.global_config;
        let total_fee = (gross_lamports_out as u128)
            .checked_mul(config.fee_bps as u128)
            .ok_or(CookieError::MathOverflow)?
            .checked_div(10000)
            .ok_or(CookieError::MathOverflow)? as u64;

        let net_payout = gross_lamports_out
            .checked_sub(total_fee)
            .ok_or(CookieError::MathOverflow)?;

        require!(net_payout >= min_lamports_out, CookieError::SlippageExceeded);

        user_pos.shares_held = user_pos
            .shares_held
            .checked_sub(shares_in)
            .ok_or(CookieError::MathOverflow)?;
        registry.total_shares = registry
            .total_shares
            .checked_sub(shares_in)
            .ok_or(CookieError::MathOverflow)?;
        registry.reserve_lamports = registry
            .reserve_lamports
            .checked_sub(gross_lamports_out)
            .ok_or(CookieError::MathOverflow)?;

        // Disburse lamports from vault PDA to seller
        let agent_id_bytes = registry.agent_id.as_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            VAULT_RESERVE_SEED,
            agent_id_bytes,
            &[registry.vault_bump],
        ]];

        **ctx.accounts.vault_reserve.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .vault_reserve
            .to_account_info()
            .lamports()
            .checked_sub(net_payout)
            .ok_or(CookieError::MathOverflow)?;

        **ctx.accounts.seller.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .seller
            .to_account_info()
            .lamports()
            .checked_add(net_payout)
            .ok_or(CookieError::MathOverflow)?;

        // Distribute exit fees
        if total_fee > 0 {
            **ctx.accounts.vault_reserve.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts
                .vault_reserve
                .to_account_info()
                .lamports()
                .checked_sub(total_fee)
                .ok_or(CookieError::MathOverflow)?;

            **ctx.accounts.protocol_treasury.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts
                .protocol_treasury
                .to_account_info()
                .lamports()
                .checked_add(total_fee)
                .ok_or(CookieError::MathOverflow)?;
        }

        emit!(SharesSold {
            agent_id: registry.agent_id.clone(),
            seller: ctx.accounts.seller.key(),
            shares_burned: shares_in,
            lamports_returned: net_payout,
            reserve_balance: registry.reserve_lamports,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Math Primitives: Mindshare-Weighted Polynomial Bonding Curve
// -----------------------------------------------------------------------------

/// Bonding Curve: P(S) = (k * S^2) * (1 + Mindshare / 10,000)
/// Integral: R(S) = (k / 3 * S^3) * MindshareScalar
pub fn calculate_purchase_return(
    total_shares: u64,
    reserve_lamports: u64,
    mindshare_score: u64,
    deposit_amount: u64,
) -> Result<u64> {
    if total_shares == 0 || reserve_lamports == 0 {
        // Bootstrap pricing: 1 Share = 1,000,000 Lamports (0.001 SOL) scaled
        let initial_shares = (deposit_amount as u128)
            .checked_mul(1_000)
            .ok_or(CookieError::MathOverflow)?
            .checked_div(1_000_000)
            .ok_or(CookieError::MathOverflow)? as u64;
        return Ok(std::cmp::max(initial_shares, 1));
    }

    // Dynamic slope scalar influenced by Cookie Mindshare
    let mindshare_factor = 10_000u128
        .checked_add(mindshare_score as u128)
        .ok_or(CookieError::MathOverflow)?;

    let s = total_shares as u128;
    let r = reserve_lamports as u128;
    let d = deposit_amount as u128;

    // Delta S = S * ((1 + d / r)^(1/2) - 1) approximated safely via fixed-point
    let ratio = d
        .checked_mul(SCALING_FACTOR)
        .ok_or(CookieError::MathOverflow)?
        .checked_div(r)
        .ok_or(CookieError::MathOverflow)?;

    let multiplier = integer_sqrt(SCALING_FACTOR.checked_add(ratio).ok_or(CookieError::MathOverflow)?);
    let normalized_diff = multiplier
        .checked_sub(31622) // sqrt(1e9) ~ 31622.77
        .unwrap_or(0);

    let base_mint = s
        .checked_mul(normalized_diff)
        .ok_or(CookieError::MathOverflow)?
        .checked_div(31622)
        .ok_or(CookieError::MathOverflow)?;

    // Modulate by mindshare velocity
    let final_shares = base_mint
        .checked_mul(10_000)
        .ok_or(CookieError::MathOverflow)?
        .checked_div(mindshare_factor)
        .ok_or(CookieError::MathOverflow)? as u64;

    Ok(std::cmp::max(final_shares, 1))
}

pub fn calculate_liquidation_return(
    total_shares: u64,
    reserve_lamports: u64,
    _mindshare_score: u64,
    shares_to_burn: u64,
) -> Result<u64> {
    require!(shares_to_burn <= total_shares, CookieError::InsufficientShares);
    if shares_to_burn == total_shares {
        return Ok(reserve_lamports);
    }

    // Pro-rata quadratic liquidation value
    let s = total_shares as u128;
    let r = reserve_lamports as u128;
    let burn = shares_to_burn as u128;

    let burned_ratio = burn
        .checked_mul(SCALING_FACTOR)
        .ok_or(CookieError::MathOverflow)?
        .checked_div(s)
        .ok_or(CookieError::MathOverflow)?;

    let return_lamports = r
        .checked_mul(burned_ratio)
        .ok_or(CookieError::MathOverflow)?
        .checked_div(SCALING_FACTOR)
        .ok_or(CookieError::MathOverflow)? as u64;

    Ok(std::cmp::min(return_lamports, reserve_lamports))
}

fn integer_sqrt(val: u128) -> u128 {
    let mut x0 = val / 2;
    if x0 != 0 {
        let mut x1 = (x0 + val / x0) / 2;
        while x1 < x0 {
            x0 = x1;
            x1 = (x0 + val / x0) / 2;
        }
        x0
    } else {
        val
    }
}

// -----------------------------------------------------------------------------
// Security Checks: Sysvar Instruction Introspection for Ed25519 Signatures
// -----------------------------------------------------------------------------
pub fn verify_ed25519_ix(
    instructions_sysvar: &AccountInfo,
    expected_signer: &[u8; 32],
    data: &[u8],
    timestamp: i64,
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)?;
    require!(current_index > 0, CookieError::MissingSignatureVerificationPrecursor);

    let precursor_ix: Instruction = load_instruction_at_checked(
        (current_index - 1) as usize,
        instructions_sysvar,
    )?;

    // Ed25519 Native Program ID Check
    require!(
        precursor_ix.program_id == anchor_lang::solana_program::ed25519_program::ID,
        CookieError::InvalidSignaturePrecursorProgram
    );

    // Verify packet header parameters
    let ix_data = &precursor_ix.data;
    require!(ix_data.len() >= 16 + 32 + 64, CookieError::MalformedSignatureData);

    // Public Key Extraction from Ed25519 Instruction format
    let pubkey_offset = u16::from_le_bytes([ix_data[6], ix_data[7]]) as usize;
    let signer_pubkey = &ix_data[pubkey_offset..pubkey_offset + 32];
    require!(signer_pubkey == expected_signer, CookieError::UnauthorizedOracleSigner);

    // Message payload comparison
    let msg_offset = u16::from_le_bytes([ix_data[10], ix_data[11]]) as usize;
    let msg_size = u16::from_le_bytes([ix_data[12], ix_data[13]]) as usize;
    let message = &ix_data[msg_offset..msg_offset + msg_size];

    let mut expected_message = Vec::with_capacity(data.len() + 8);
    expected_message.extend_from_slice(data);
    expected_message.extend_from_slice(&timestamp.to_le_bytes());

    require!(message == expected_message.as_slice(), CookieError::OracleMessagePayloadMismatch);

    Ok(())
}

// -----------------------------------------------------------------------------
// Account Context Layouts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub fn initialize_protocol<'info>(
    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [GLOBAL_CONFIG_SEED],
        bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub fn register_agent<'info>(
    #[account(
        mut,
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = creator,
        space = 8 + AgentRegistry::INIT_SPACE,
        seeds = [AGENT_REGISTRY_SEED, agent_id.as_bytes()],
        bump
    )]
    pub agent_registry: Account<'info, AgentRegistry>,
    /// CHECK: PDA reserve account, initialized on demand
    #[account(
        mut,
        seeds = [VAULT_RESERVE_SEED, agent_id.as_bytes()],
        bump
    )]
    pub vault_reserve: AccountInfo<'info>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub fn update_mindshare<'info>(
    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [AGENT_REGISTRY_SEED, agent_registry.agent_id.as_bytes()],
        bump = agent_registry.bump
    )]
    pub agent_registry: Account<'info, AgentRegistry>,
    /// CHECK: Validated against sysvar::instructions ID
    #[account(address = IX_SYSVAR_ID @ CookieError::InvalidSysvar)]
    pub instructions_sysvar: AccountInfo<'info>,
}

#[derive(Accounts)]
pub fn buy_agent_shares<'info>(
    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [AGENT_REGISTRY_SEED, agent_registry.agent_id.as_bytes()],
        bump = agent_registry.bump
    )]
    pub agent_registry: Account<'info, AgentRegistry>,
    /// CHECK: Validated PDA vault
    #[account(
        mut,
        seeds = [VAULT_RESERVE_SEED, agent_registry.agent_id.as_bytes()],
        bump = agent_registry.vault_bump
    )]
    pub vault_reserve: AccountInfo<'info>,
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + UserPosition::INIT_SPACE,
        seeds = [USER_POSITION_SEED, agent_registry.key().as_ref(), buyer.key().as_ref()],
        bump
    )]
    pub user_position: Account<'info, UserPosition>,
    /// CHECK: Validated creator recipient
    #[account(mut, address = agent_registry.creator @ CookieError::InvalidCreatorAddress)]
    pub creator: AccountInfo<'info>,
    /// CHECK: Validated DAO treasury
    #[account(mut, address = global_config.admin @ CookieError::InvalidAdminAddress)]
    pub protocol_treasury: AccountInfo<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub fn sell_agent_shares<'info>(
    #[account(
        seeds = [GLOBAL_CONFIG_SEED],
        bump = global_config.bump
    )]
    pub global_config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [AGENT_REGISTRY_SEED, agent_registry.agent_id.as_bytes()],
        bump = agent_registry.bump
    )]
    pub agent_registry: Account<'info, AgentRegistry>,
    /// CHECK: PDA verified via seed derivation
    #[account(
        mut,
        seeds = [VAULT_RESERVE_SEED, agent_registry.agent_id.as_bytes()],
        bump = agent_registry.vault_bump
    )]
    pub vault_reserve: AccountInfo<'info>,
    #[account(
        mut,
        seeds = [USER_POSITION_SEED, agent_registry.key().as_ref(), seller.key().as_ref()],
        bump
    )]
    pub user_position: Account<'info, UserPosition>,
    /// CHECK: Protocol treasury
    #[account(mut, address = global_config.admin @ CookieError::InvalidAdminAddress)]
    pub protocol_treasury: AccountInfo<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// State Accounts
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub oracle_signer: Pubkey,
    pub fee_bps: u16,
    pub total_agents: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AgentRegistry {
    pub creator: Pubkey,
    #[max_len(32)]
    pub agent_id: String,
    pub mindshare_score: u64,
    pub total_shares: u64,
    pub reserve_lamports: u64,
    pub last_update_ts: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserPosition {
    pub owner: Pubkey,
    pub agent_registry: Pubkey,
    pub shares_held: u64,
}

// -----------------------------------------------------------------------------
// Events & Errors
// -----------------------------------------------------------------------------

#[event]
pub struct ProtocolInitialized {
    pub admin: Pubkey,
    pub oracle_signer: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct AgentRegistered {
    pub agent_id: String,
    pub creator: Pubkey,
    pub initial_mindshare: u64,
}

#[event]
pub struct MindshareUpdated {
    pub agent_id: String,
    pub old_mindshare: u64,
    pub new_mindshare: u64,
    pub timestamp: i64,
}

#[event]
pub struct SharesPurchased {
    pub agent_id: String,
    pub buyer: Pubkey,
    pub lamports_spent: u64,
    pub shares_minted: u64,
    pub reserve_balance: u64,
}

#[event]
pub struct SharesSold {
    pub agent_id: String,
    pub seller: Pubkey,
    pub shares_burned: u64,
    pub lamports_returned: u64,
    pub reserve_balance: u64,
}

#[error_code]
pub enum CookieError {
    #[msg("Protocol fee exceeds maximum allowed threshold.")]
    FeeExceedsMaximum,
    #[msg("Agent ID string length exceeds 32 bytes.")]
    AgentIdTooLong,
    #[msg("Mindshare score must be strictly positive.")]
    InvalidMindshareScore,
    #[msg("Math calculation resulted in overflow or underflow.")]
    MathOverflow,
    #[msg("Oracle timestamp is expired or too far in the future.")]
    TimestampExpired,
    #[msg("Data submitted is older than the last recorded epoch.")]
    StaleDataSubmitted,
    #[msg("Transaction must be preceded by an Ed25519 signature verification instruction.")]
    MissingSignatureVerificationPrecursor,
    #[msg("Instruction preceding this call is not the official Ed25519 program.")]
    InvalidSignaturePrecursorProgram,
    #[msg("Ed25519 instruction data is malformed.")]
    MalformedSignatureData,
    #[msg("Signature was not signed by the authorized Cookie oracle key.")]
    UnauthorizedOracleSigner,
    #[msg("Oracle payload bytes do not match the expected state values.")]
    OracleMessagePayloadMismatch,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Slippage tolerance exceeded.")]
    SlippageExceeded,
    #[msg("Insufficient shares balance to liquidate.")]
    InsufficientShares,
    #[msg("Invalid Sysvar Account passed.")]
    InvalidSysvar,
    #[msg("Provided creator address does not match Agent Registry creator.")]
    InvalidCreatorAddress,
    #[msg("Provided admin address does not match Global Config.")]
    InvalidAdminAddress,
}