use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("Cook1ePu1se111111111111111111111111111111111");

#[program]
pub mod cookie_pulse {
    use super::*;

    pub fn initialize(
        ctx: Context<InitializeProtocol>,
        oracle_authority: Pubkey,
        protocol_fee_bps: u16,
        max_staleness_seconds: i64,
    ) -> Result<()> {
        instructions::initialize::handle_initialize(
            ctx,
            oracle_authority,
            protocol_fee_bps,
            max_staleness_seconds,
        )
    }

    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_uuid: [u8; 16],
        base_rate_bps: u64,
    ) -> Result<()> {
        instructions::register_agent::handle_register_agent(ctx, agent_uuid, base_rate_bps)
    }

    pub fn update_mindshare(
        ctx: Context<UpdateAgentMindshare>,
        payload: MindsharePayload,
    ) -> Result<()> {
        instructions::update_mindshare::handle_update_mindshare(ctx, payload)
    }

    pub fn stake(ctx: Context<StakeTokens>, amount: u64) -> Result<()> {
        instructions::stake::handle_stake(ctx, amount)
    }

    pub fn unstake(ctx: Context<UnstakeTokens>, amount: u64) -> Result<()> {
        instructions::unstake::handle_unstake(ctx, amount)
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::claim_rewards::handle_claim_rewards(ctx)
    }
}