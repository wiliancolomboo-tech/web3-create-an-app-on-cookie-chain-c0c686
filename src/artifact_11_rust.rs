use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use crate::state::{GlobalConfig, AgentAccount, BondingPool, UserStake};
use crate::errors::CookieError;

#[derive(Accounts)]
pub struct BuyShares<'info> {
    #[account(seeds = [b"global-config"], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(mut, seeds = [b"agent", agent.agent_id.as_bytes()], bump = agent.bump)]
    pub agent: Account<'info, AgentAccount>,

    #[account(mut, seeds = [b"bonding-pool", agent.key().as_ref()], bump = pool.pool_bump)]
    pub pool: Account<'info, BondingPool>,

    /// CHECK: PDA reserve vault
    #[account(mut, seeds = [b"pool-vault", agent.key().as_ref()], bump = pool.vault_bump)]
    pub pool_vault: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = UserStake::LEN,
        seeds = [b"user-stake", pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_stake: Account<'info, UserStake>,

    /// CHECK: Agent payout treasury
    #[account(mut, address = agent.treasury)]
    pub agent_treasury: AccountInfo<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BuyShares>, sol_amount_in: u64, min_shares_out: u64) -> Result<()> {
    require!(sol_amount_in > 0, CookieError::InsufficientPoolLiquidity);

    let config = &ctx.accounts.config;
    let agent = &ctx.accounts.agent;
    let pool = &mut ctx.accounts.pool;

    // Fee calculations
    let protocol_fee = (sol_amount_in as u128)
        .checked_mul(config.protocol_fee_bps as u128).ok_or(CookieError::MathOverflow)?
        .checked_div(10000).ok_or(CookieError::MathOverflow)? as u64;

    let agent_fee = (sol_amount_in as u128)
        .checked_mul(agent.agent_fee_bps as u128).ok_or(CookieError::MathOverflow)?
        .checked_div(10000).ok_or(CookieError::MathOverflow)? as u64;

    let net_deposit = sol_amount_in
        .checked_sub(protocol_fee).ok_or(CookieError::MathOverflow)?
        .checked_sub(agent_fee).ok_or(CookieError::MathOverflow)?;

    // Linear dynamic pricing with mindshare bonus multiplier
    // effective_price = base_price + (total_supply * 1000) / dynamic_multiplier
    let current_price = (pool.base_price as u128)
        .checked_add(
            (pool.total_supply as u128)
                .checked_mul(1_000_000).ok_or(CookieError::MathOverflow)?
                .checked_div(pool.dynamic_multiplier as u128).ok_or(CookieError::MathOverflow)?
        ).ok_or(CookieError::MathOverflow)? as u64;

    let shares_minted = ((net_deposit as u128)
        .checked_mul(1_000_000_000).ok_or(CookieError::MathOverflow)?
        .checked_div(current_price as u128).ok_or(CookieError::MathOverflow)?) as u64;

    require!(shares_minted >= min_shares_out, CookieError::SlippageExceeded);

    // CPI transfer: Deposit net SOL to pool vault
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.pool_vault.to_account_info(),
            },
        ),
        net_deposit,
    )?;

    // CPI transfer: Direct routing of agent creator fee
    if agent_fee > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user.to_account_info(),
                    to: ctx.accounts.agent_treasury.to_account_info(),
                },
            ),
            agent_fee,
        )?;
    }

    // Update pool & user state
    pool.reserve_balance = pool.reserve_balance.checked_add(net_deposit).ok_or(CookieError::MathOverflow)?;
    pool.total_supply = pool.total_supply.checked_add(shares_minted).ok_or(CookieError::MathOverflow)?;

    let user_stake = &mut ctx.accounts.user_stake;
    if user_stake.shares == 0 {
        user_stake.user = ctx.accounts.user.key();
        user_stake.pool = pool.key();
        user_stake.bump = ctx.bumps.user_stake;
        ctx.accounts.agent.total_stakers = ctx.accounts.agent.total_stakers.checked_add(1).ok_or(CookieError::MathOverflow)?;
    }
    user_stake.shares = user_stake.shares.checked_add(shares_minted).ok_or(CookieError::MathOverflow)?;
    user_stake.total_invested_lamports = user_stake.total_invested_lamports.checked_add(sol_amount_in).ok_or(CookieError::MathOverflow)?;

    Ok(())
}