use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("CooKie1111111111111111111111111111111111111");

#[program]
pub mod cookie_chain_app {
    use super::*;

    /// Initializes the protocol global configuration
    pub fn initialize(
        ctx: Context<Initialize>,
        protocol_fee_bps: u16,
        oracle_authority: Pubkey,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, protocol_fee_bps, oracle_authority)
    }

    /// Registers a new AI Agent with dynamic bonding capabilities
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_id: String,
        metadata_uri: String,
        agent_fee_bps: u16,
    ) -> Result<()> {
        instructions::register_agent::handler(ctx, agent_id, metadata_uri, agent_fee_bps)
    }

    /// Ingests authenticated Cookie Mindshare metrics to rebalance bonding curve weights
    pub fn update_mindshare(
        ctx: Context<UpdateMindshare>,
        mindshare_score: u64,
        mindshare_rank: u32,
        epoch: u64,
    ) -> Result<()> {
        instructions::update_mindshare::handler(ctx, mindshare_score, mindshare_rank, epoch)
    }

    /// Purchases Attention Shares using native SOL via constant-product/exponential hybrid curve
    pub fn buy_shares(
        ctx: Context<BuyShares>,
        sol_amount_in: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::buy_shares::handler(ctx, sol_amount_in, min_shares_out)
    }

    /// Liquidates Attention Shares back to SOL with dynamic mindshare spread deductions
    pub fn sell_shares(
        ctx: Context<SellShares>,
        shares_to_burn: u64,
        min_sol_out: u64,
    ) -> Result<()> {
        instructions::sell_shares::handler(ctx, shares_to_burn, min_sol_out)
    }
}