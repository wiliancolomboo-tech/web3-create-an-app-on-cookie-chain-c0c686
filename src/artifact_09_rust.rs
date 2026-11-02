use anchor_lang::prelude::*;
use crate::state::{GlobalConfig, AgentAccount, BondingPool};
use crate::errors::CookieError;

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct RegisterAgent<'info> {
    #[account(
        mut,
        seeds = [b"global-config"],
        bump = config.bump
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = creator,
        space = AgentAccount::LEN,
        seeds = [b"agent", agent_id.as_bytes()],
        bump
    )]
    pub agent: Account<'info, AgentAccount>,

    #[account(
        init,
        payer = creator,
        space = BondingPool::LEN,
        seeds = [b"bonding-pool", agent.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, BondingPool>,

    /// CHECK: Native SOL vault PDA authorized solely by bonding pool seeds
    #[account(
        mut,
        seeds = [b"pool-vault", agent.key().as_ref()],
        bump
    )]
    pub pool_vault: AccountInfo<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: Payout treasury verified by creator
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterAgent>,
    agent_id: String,
    metadata_uri: String,
    agent_fee_bps: u16,
) -> Result<()> {
    require!(agent_id.len() <= AgentAccount::MAX_ID_LEN, CookieError::IdTooLong);
    require!(metadata_uri.len() <= AgentAccount::MAX_URI_LEN, CookieError::UriTooLong);
    require!(agent_fee_bps <= 1500, CookieError::InvalidFeeConfiguration); // Max 15%

    let agent = &mut ctx.accounts.agent;
    agent.agent_id = agent_id;
    agent.metadata_uri = metadata_uri;
    agent.treasury = ctx.accounts.treasury.key();
    agent.mindshare_score = 10_000; // Baseline initial mindshare
    agent.mindshare_rank = 100_000;
    agent.last_updated_epoch = Clock::get()?.epoch;
    agent.total_stakers = 0;
    agent.agent_fee_bps = agent_fee_bps;
    agent.bump = ctx.bumps.agent;

    let pool = &mut ctx.accounts.pool;
    pool.agent = agent.key();
    pool.reserve_balance = 0;
    pool.total_supply = 0;
    pool.base_price = 1_000_000; // 0.001 SOL per share base
    pool.dynamic_multiplier = 1_000_000; // 1.0x initial scale
    pool.vault_bump = ctx.bumps.pool_vault;
    pool.pool_bump = ctx.bumps.pool;

    let config = &mut ctx.accounts.config;
    config.total_agents = config.total_agents.checked_add(1).ok_or(CookieError::MathOverflow)?;

    Ok(())
}