use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{AgentMindshare, UserStake, ACC_PRECISION};
use crate::errors::CookieStreamError;

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct ClaimRewards<'info> {
    #[account(
        mut,
        seeds = [b"agent_metrics", agent_id.as_bytes()],
        bump = agent_state.bump
    )]
    pub agent_state: Account<'info, AgentMindshare>,

    #[account(
        mut,
        seeds = [b"reward_vault", agent_id.as_bytes()],
        bump = agent_state.reward_vault_bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"user_stake", agent_id.as_bytes(), user.key().as_ref()],
        bump = user_stake.bump,
        has_one = owner @ CookieStreamError::UnauthorizedAdmin
    )]
    pub user_stake: Account<'info, UserStake>,

    #[account(mut)]
    pub user_reward_account: Account<'info, TokenAccount>,

    pub owner: Signer<'info>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimRewards>, agent_id: String) -> Result<()> {
    let agent = &ctx.accounts.agent_state;
    let user_stake = &mut ctx.accounts.user_stake;

    // Calculate accrued since last checkpoint
    let gross_accumulated = (user_stake.amount as u128)
        .checked_mul(agent.acc_reward_per_share)
        .ok_or(CookieStreamError::MathOverflow)?
        .checked_div(ACC_PRECISION)
        .ok_or(CookieStreamError::MathOverflow)?;

    let delta_rewards = gross_accumulated
        .checked_sub(user_stake.reward_debt)
        .ok_or(CookieStreamError::MathOverflow)? as u64;

    let claimable = user_stake
        .pending_rewards
        .checked_add(delta_rewards)
        .ok_or(CookieStreamError::MathOverflow)?;

    require!(claimable > 0, CookieStreamError::ZeroAmount);

    // Reset pending values and synchronize debt
    user_stake.pending_rewards = 0;
    user_stake.reward_debt = gross_accumulated;

    // Sign PDA Transfer from Reward Vault
    let seeds = &[
        b"agent_metrics",
        agent_id.as_bytes(),
        &[agent.bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.reward_vault.to_account_info(),
        to: ctx.accounts.user_reward_account.to_account_info(),
        authority: agent.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    token::transfer(cpi_ctx, claimable)?;

    Ok(())
}