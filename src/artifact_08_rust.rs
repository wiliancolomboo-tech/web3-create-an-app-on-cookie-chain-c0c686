use anchor_lang::prelude::*;
use crate::state::GlobalConfig;
use crate::errors::CookieError;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = GlobalConfig::LEN,
        seeds = [b"global-config"],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Initialize>,
    protocol_fee_bps: u16,
    oracle_authority: Pubkey,
) -> Result<()> {
    require!(protocol_fee_bps <= 1000, CookieError::InvalidFeeConfiguration);
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.oracle_authority = oracle_authority;
    config.protocol_fee_bps = protocol_fee_bps;
    config.total_agents = 0;
    config.bump = ctx.bumps.config;
    Ok(())
}