use anchor_lang::prelude::*;
use crate::state::{AgentAccount, BondingPool, UserStake};
use crate::errors::CookieError;

#[derive(Accounts)]
pub struct SellShares<'info> {
    #[account(mut, seeds = [b"agent", agent.agent_id.as_bytes()], bump = agent.bump)]
    pub agent: Account<'info, AgentAccount>,

    #[account(mut, seeds = [b"bonding-pool", agent.key().as_ref()], bump = pool.pool_bump)]
    pub pool: Account<'info, BondingPool>,

    /// CHECK: PDA reserve vault checked by derived seeds
    #[account(mut, seeds = [b"pool-vault", agent.key().as_ref()], bump = pool.vault_bump)]
    pub pool_vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"user-stake", pool.key().as_ref(), user.key().as_ref()],
        bump = user_stake.bump
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SellShares>, shares_to_burn: u64, min_sol_out: u64) -> Result<()> {
    let user_stake = &mut ctx.accounts.user_stake;
    require!(user_stake.shares >= shares_to_burn, CookieError::InsufficientShares);

    let pool = &mut ctx.accounts.pool;

    let current_price = (pool.base_price as u128)
        .checked_add(
            (pool.total_supply as u128)
                .checked_mul(1_000_000).ok_or(CookieError::MathOverflow)?
                .checked_div(pool.dynamic_multiplier as u128).ok_or(CookieError::MathOverflow)?
        ).ok_or(CookieError::MathOverflow)? as u64;

    let gross_sol = ((shares_to_burn as u128)
        .checked_mul(current_price as u128).ok_or(CookieError::MathOverflow)?
        .checked_div(1_000_000_000).ok_or(CookieError::MathOverflow)?) as u64;

    // Apply sell exit fee (2.5% exit spread)
    let exit_fee = (gross_sol as u128).checked_mul(250).unwrap().checked_div(10000).unwrap() as u64;
    let net_sol_out = gross_sol.checked_sub(exit_fee).ok_or(CookieError::MathOverflow)?;

    require!(net_sol_out >= min_sol_out, CookieError::SlippageExceeded);
    require!(**ctx.accounts.pool_vault.lamports.borrow() >= net_sol_out, CookieError::InsufficientPoolLiquidity);

    // Burn shares and deduct supply
    user_stake.shares = user_stake.shares.checked_sub(shares_to_burn).ok_or(CookieError::MathOverflow)?;
    pool.total_supply = pool.total_supply.checked_sub(shares_to_burn).ok_or(CookieError::MathOverflow)?;
    pool.reserve_balance = pool.reserve_balance.checked_sub(net_sol_out).ok_or(CookieError::MathOverflow)?;

    // Safe PDA Transfer from Pool Vault to User using Native Lamport Reallocation
    **ctx.accounts.pool_vault.try_borrow_mut_lamports()? = ctx
        .accounts
        .pool_vault
        .lamports()
        .checked_sub(net_sol_out)
        .ok_or(CookieError::MathOverflow)?;

    **ctx.accounts.user.try_borrow_mut_lamports()? = ctx
        .accounts
        .user
        .lamports()
        .checked_add(net_sol_out)
        .ok_or(CookieError::MathOverflow)?;

    Ok(())
}