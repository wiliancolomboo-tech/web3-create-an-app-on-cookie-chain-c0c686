use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{AgentMindshare, UserStake, ACC_PRECISION};
use crate::errors::CookieStreamError;

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct Unstake<'info> {
    #[account(
        mut,
        seeds = [b"agent_metrics", agent_id.as_bytes()],
        bump = agent_state.bump
    )]
    pub agent_state: Account<'info, AgentMindshare>,

    #[account(
        mut,
        seeds = [b"stake_vault", agent_id.as_bytes()],
        bump = agent_state.stake_vault_bump
    )]
    pub stake_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"user_stake", agent_id.as_bytes(), user.key().as_ref()],
        bump = user_stake.bump,
        has_one = owner @ CookieStreamError::UnauthorizedAdmin
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,

    pub owner: Signer<'info>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Unstake>, agent_id: String, amount: u64) -> Result<()> {
    require!(amount > 0, CookieStreamError::ZeroAmount);
    let agent = &mut ctx.accounts.agent_state;
    let user_stake = &mut ctx.accounts.user_stake;

    require!(user_stake.amount >= amount, CookieStreamError::InsufficientStakeBalance);

    // Harvest / Settle Pending
    let gross_accumulated = (user_stake.amount as u128)
        .checked_mul(agent.acc_reward_per_share)
        .ok_or(CookieStreamError::MathOverflow)?
        .checked_div(ACC_PRECISION)
        .ok_or(CookieStreamError::MathOverflow)?;

    let delta_rewards = gross_accumulated
        .checked_sub(user_stake.reward_debt)
        .ok_or(CookieStreamError::MathOverflow)? as u64;

    user_stake.pending_rewards = user_stake
        .pending_rewards
        .checked_add(delta_rewards)
        .ok_or(CookieStreamError::MathOverflow)?;

    // Mutate state before CPI (reentrancy defense)
    user_stake.amount = user_stake.amount.checked_sub(amount).ok_or(CookieStreamError::MathOverflow)?;
    user_stake.reward_debt = (user_stake.amount as u128)
        .checked_mul(agent.acc_reward_per_share)
        .ok_or(CookieStreamError::MathOverflow)?
        .checked_div(ACC_PRECISION)
        .ok_or(CookieStreamError::MathOverflow)?;
    agent.total_staked = agent.total_staked.checked_sub(amount).ok_or(CookieStreamError::MathOverflow)?;

    // Release tokens using Agent PDA signer
    let seeds = &[
        b"agent_metrics",
        agent_id.as_bytes(),
        &[agent.bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.stake_vault.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: agent.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    token::transfer(cpi_ctx, amount)?;

    Ok(())
}