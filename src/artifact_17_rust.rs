use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::AgentScoreEntry;

declare_id!("Cook1ePu1se111111111111111111111111111111111");

#[program]
pub mod cookie_pulse {
    use super::*;

    pub fn initialize(ctx: Context<InitializeProtocol>) -> Result<()> {
        handle_initialize(ctx)
    }

    pub fn register_agent(ctx: Context<RegisterAgent>, agent_id: [u8; 32]) -> Result<()> {
        handle_register_agent(ctx, agent_id)
    }

    pub fn create_and_fund_pool(
        ctx: Context<CreateAndFundPool>,
        pool_id: u64,
        initial_deposit: u64,
    ) -> Result<()> {
        handle_create_and_fund_pool(ctx, pool_id, initial_deposit)
    }

    pub fn commit_attribution(
        ctx: Context<CommitAttribution>,
        epoch: u64,
        reward_amount: u64,
        entries: Vec<AgentScoreEntry>,
    ) -> Result<()> {
        handle_commit_attribution(ctx, epoch, reward_amount, entries)
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>, epoch: u64) -> Result<()> {
        handle_claim_rewards(ctx, epoch)
    }
}