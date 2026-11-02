use anchor_lang::prelude::*;
use crate::state::{GlobalConfig, AgentAccount, BondingPool};
use crate::errors::CookieError;

#[derive(Accounts)]
pub struct UpdateMindshare<'info> {
    #[account(
        seeds = [b"global-config"],
        bump = config.bump,
        has_one = oracle_authority @ CookieError::UnauthorizedOracle
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_bytes()],
        bump = agent.bump
    )]
    pub agent: Account<'info, AgentAccount>,

    #[account(
        mut,
        seeds = [b"bonding-pool", agent.key().as_ref()],
        bump = pool.pool_bump
    )]
    pub pool: Account<'info, BondingPool>,

    pub oracle_authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdateMindshare>,
    mindshare_score: u64,
    mindshare_rank: u32,
    epoch: u64,
) -> Result<()> {
    let agent = &mut ctx.accounts.agent;
    let pool = &mut ctx.accounts.pool;

    require!(epoch >= agent.last_updated_epoch, CookieError::StaleOracleUpdate);

    agent.mindshare_score = mindshare_score;
    agent.mindshare_rank = mindshare_rank;
    agent.last_updated_epoch = epoch;

    // Dynamically adjust pool multiplier: Base (1x = 1,000,000) + Mindshare bonus (Score / 2)
    // Dynamic Multiplier boosts liquidity curve depth
    let computed_multiplier = 1_000_000u64
        .checked_add(mindshare_score.checked_div(2).ok_or(CookieError::MathOverflow)?)
        .ok_or(CookieError::MathOverflow)?;

    pool.dynamic_multiplier = computed_multiplier;

    Ok(())
}