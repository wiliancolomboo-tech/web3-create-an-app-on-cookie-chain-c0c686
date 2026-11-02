use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("CkJr6ZzTj29kGgQJq5qV7sK3N2m7k9aY1pW4vD8n9XYZ");

pub const PRECISION: u128 = 1_000_000_000;
pub const MAX_AGENT_ID_LEN: usize = 32;
pub const MAX_URI_LEN: usize = 96;

#[program]
pub mod cookie_jar {
    use super::*;

    /// Initializes global protocol configuration.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        fee_basis_points: u16,
    ) -> Result<()> {
        require!(fee_basis_points <= 1000, CookieJarError::FeeTooHigh); // Max 10%

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.oracle_authority = ctx.accounts.oracle_authority.key();
        config.fee_recipient = ctx.accounts.fee_recipient.key();
        config.reward_mint = ctx.accounts.reward_mint.key();
        config.fee_basis_points = fee_basis_points;
        config.total_agents = 0;
        config.bump = ctx.bumps.config;

        emit!(ProtocolInitializedEvent {
            admin: config.admin,
            oracle_authority: config.oracle_authority,
            reward_mint: config.reward_mint,
            fee_basis_points,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Registers a new AI Agent identity on Cookie Chain.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_id: String,
        metadata_uri: String,
    ) -> Result<()> {
        require!(
            agent_id.len() > 0 && agent_id.len() <= MAX_AGENT_ID_LEN,
            CookieJarError::InvalidStringLength
        );
        require!(
            metadata_uri.len() <= MAX_URI_LEN,
            CookieJarError::InvalidStringLength
        );

        let agent = &mut ctx.accounts.agent;
        agent.owner = ctx.accounts.owner.key();
        agent.agent_id = agent_id.clone();
        agent.metadata_uri = metadata_uri;
        agent.mindshare_score = 0;
        agent.last_mindshare_update = Clock::get()?.unix_timestamp;
        agent.total_staked = 0;
        agent.acc_reward_per_share = 0;
        agent.last_reward_block_time = Clock::get()?.unix_timestamp;
        agent.active_tasks_count = 0;
        agent.completed_tasks_count = 0;
        agent.bump = ctx.bumps.agent;
        agent.vault_bump = ctx.bumps.agent_vault;

        let config = &mut ctx.accounts.config;
        config.total_agents = config.total_agents.checked_add(1).ok_or(CookieJarError::MathOverflow)?;

        emit!(AgentRegisteredEvent {
            agent_id,
            owner: agent.owner,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Update mindshare score by authorized Cookie Mindshare Oracle.
    pub fn update_mindshare_score(
        ctx: Context<UpdateMindshareScore>,
        new_score: u64,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        let clock = Clock::get()?;

        // Calculate pending reward accretion prior to mindshare shift
        Self::internal_accumulate_rewards(agent, clock.unix_timestamp)?;

        agent.mindshare_score = new_score;
        agent.last_mindshare_update = clock.unix_timestamp;

        emit!(MindshareUpdatedEvent {
            agent_id: agent.agent_id.clone(),
            new_score,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Staking capital to support an agent's mindshare vault.
    pub fn stake_to_agent(ctx: Context<StakeToAgent>, amount: u64) -> Result<()> {
        require!(amount > 0, CookieJarError::ZeroAmount);

        let clock = Clock::get()?;
        let agent = &mut ctx.accounts.agent;
        Self::internal_accumulate_rewards(agent, clock.unix_timestamp)?;

        let user_stake = &mut ctx.accounts.user_stake;

        if user_stake.staked_amount > 0 {
            // Settle unharvested rewards first
            let pending = ((user_stake.staked_amount as u128)
                .checked_mul(agent.acc_reward_per_share)
                .ok_or(CookieJarError::MathOverflow)?)
                .checked_div(PRECISION)
                .ok_or(CookieJarError::MathOverflow)?
                .checked_sub(user_stake.reward_debt)
                .ok_or(CookieJarError::MathOverflow)? as u64;

            if pending > 0 {
                user_stake.pending_rewards = user_stake
                    .pending_rewards
                    .checked_add(pending)
                    .ok_or(CookieJarError::MathOverflow)?;
            }
        } else {
            user_stake.user = ctx.accounts.user.key();
            user_stake.agent = agent.key();
            user_stake.bump = ctx.bumps.user_stake;
            user_stake.pending_rewards = 0;
        }

        // Execute CPI transfer from staker to agent vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.agent_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount)?;

        user_stake.staked_amount = user_stake
            .staked_amount
            .checked_add(amount)
            .ok_or(CookieJarError::MathOverflow)?;
        agent.total_staked = agent
            .total_staked
            .checked_add(amount)
            .ok_or(CookieJarError::MathOverflow)?;

        user_stake.reward_debt = ((user_stake.staked_amount as u128)
            .checked_mul(agent.acc_reward_per_share)
            .ok_or(CookieJarError::MathOverflow)?)
            .checked_div(PRECISION)
            .ok_or(CookieJarError::MathOverflow)?;

        emit!(StakeDepositedEvent {
            user: ctx.accounts.user.key(),
            agent_id: agent.agent_id.clone(),
            amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Withdraw staked funds from an agent's vault.
    pub fn unstake_from_agent(ctx: Context<UnstakeFromAgent>, amount: u64) -> Result<()> {
        let user_stake = &mut ctx.accounts.user_stake;
        require!(user_stake.staked_amount >= amount, CookieJarError::InsufficientStake);

        let clock = Clock::get()?;
        let agent = &mut ctx.accounts.agent;
        Self::internal_accumulate_rewards(agent, clock.unix_timestamp)?;

        let pending = ((user_stake.staked_amount as u128)
            .checked_mul(agent.acc_reward_per_share)
            .ok_or(CookieJarError::MathOverflow)?)
            .checked_div(PRECISION)
            .ok_or(CookieJarError::MathOverflow)?
            .checked_sub(user_stake.reward_debt)
            .ok_or(CookieJarError::MathOverflow)? as u64;

        if pending > 0 {
            user_stake.pending_rewards = user_stake
                .pending_rewards
                .checked_add(pending)
                .ok_or(CookieJarError::MathOverflow)?;
        }

        user_stake.staked_amount = user_stake
            .staked_amount
            .checked_sub(amount)
            .ok_or(CookieJarError::MathOverflow)?;
        agent.total_staked = agent
            .total_staked
            .checked_sub(amount)
            .ok_or(CookieJarError::MathOverflow)?;

        user_stake.reward_debt = ((user_stake.staked_amount as u128)
            .checked_mul(agent.acc_reward_per_share)
            .ok_or(CookieJarError::MathOverflow)?)
            .checked_div(PRECISION)
            .ok_or(CookieJarError::MathOverflow)?;

        // Transfer funds back using PDA signature
        let agent_id_bytes = agent.agent_id.as_bytes();
        let bump_seeds = &[
            b"agent_vault".as_ref(),
            agent_id_bytes,
            &[agent.vault_bump],
        ];
        let signer = &[&bump_seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.agent_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.agent_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer),
            amount,
        )?;

        emit!(StakeWithdrawnEvent {
            user: ctx.accounts.user.key(),
            agent_id: agent.agent_id.clone(),
            amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Claim accrued mindshare yield tokens.
    pub fn claim_yield(ctx: Context<ClaimYield>) -> Result<()> {
        let clock = Clock::get()?;
        let agent = &mut ctx.accounts.agent;
        Self::internal_accumulate_rewards(agent, clock.unix_timestamp)?;

        let user_stake = &mut ctx.accounts.user_stake;

        let mut claimable = ((user_stake.staked_amount as u128)
            .checked_mul(agent.acc_reward_per_share)
            .ok_or(CookieJarError::MathOverflow)?)
            .checked_div(PRECISION)
            .ok_or(CookieJarError::MathOverflow)?
            .checked_sub(user_stake.reward_debt)
            .ok_or(CookieJarError::MathOverflow)? as u64;

        claimable = claimable
            .checked_add(user_stake.pending_rewards)
            .ok_or(CookieJarError::MathOverflow)?;
        require!(claimable > 0, CookieJarError::NoYieldToClaim);

        user_stake.pending_rewards = 0;
        user_stake.reward_debt = ((user_stake.staked_amount as u128)
            .checked_mul(agent.acc_reward_per_share)
            .ok_or(CookieJarError::MathOverflow)?)
            .checked_div(PRECISION)
            .ok_or(CookieJarError::MathOverflow)?;

        // Send tokens from the global rewards pool
        let config_bump = ctx.accounts.config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"config".as_ref(), &[config_bump]]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.rewards_pool_vault.to_account_info(),
            to: ctx.accounts.user_reward_token_account.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
            claimable,
        )?;

        emit!(YieldHarvestedEvent {
            user: ctx.accounts.user.key(),
            agent_id: agent.agent_id.clone(),
            amount: claimable,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Create an Agent-to-Agent (A2A) Task Escrow with strict timeout.
    pub fn create_task_escrow(
        ctx: Context<CreateTaskEscrow>,
        task_id: [u8; 16],
        reward_amount: u64,
        timeout_seconds: i64,
    ) -> Result<()> {
        require!(reward_amount > 0, CookieJarError::ZeroAmount);
        require!(timeout_seconds >= 60, CookieJarError::TimeoutTooShort);

        let clock = Clock::get()?;
        let task = &mut ctx.accounts.task_escrow;
        task.task_id = task_id;
        task.employer = ctx.accounts.employer.key();
        task.contractor = ctx.accounts.contractor.key();
        task.reward_amount = reward_amount;
        task.deadline = clock
            .unix_timestamp
            .checked_add(timeout_seconds)
            .ok_or(CookieJarError::MathOverflow)?;
        task.is_completed = false;
        task.is_disputed = false;
        task.bump = ctx.bumps.task_escrow;
        task.vault_bump = ctx.bumps.escrow_vault;

        // Escrow funds transfer
        let cpi_accounts = Transfer {
            from: ctx.accounts.employer_token_account.to_account_info(),
            to: ctx.accounts.escrow_vault.to_account_info(),
            authority: ctx.accounts.employer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), reward_amount)?;

        let contractor_agent = &mut ctx.accounts.contractor_agent;
        contractor_agent.active_tasks_count = contractor_agent
            .active_tasks_count
            .checked_add(1)
            .ok_or(CookieJarError::MathOverflow)?;

        emit!(TaskEscrowCreatedEvent {
            task_id,
            employer: task.employer,
            contractor: task.contractor,
            reward_amount,
            deadline: task.deadline,
        });

        Ok(())
    }

    /// Complete an A2A task and release escrow payment to contractor agent.
    pub fn complete_task(ctx: Context<CompleteTask>) -> Result<()> {
        let task = &mut ctx.accounts.task_escrow;
        require!(!task.is_completed, CookieJarError::TaskAlreadyCompleted);
        require!(!task.is_disputed, CookieJarError::TaskInDispute);

        let config = &ctx.accounts.config;
        let total_amount = task.reward_amount;

        // Calculate protocol fee
        let fee = ((total_amount as u128)
            .checked_mul(config.fee_basis_points as u128)
            .ok_or(CookieJarError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(CookieJarError::MathOverflow)?) as u64;

        let net_payout = total_amount
            .checked_sub(fee)
            .ok_or(CookieJarError::MathOverflow)?;

        let task_id_bytes = task.task_id;
        let vault_bump = task.vault_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow_vault".as_ref(),
            task_id_bytes.as_ref(),
            &[vault_bump],
        ]];

        let cpi_program = ctx.accounts.token_program.to_account_info();

        // 1. Pay Contractor
        let cpi_contractor = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: ctx.accounts.contractor_token_account.to_account_info(),
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(cpi_program.clone(), cpi_contractor, signer_seeds),
            net_payout,
        )?;

        // 2. Pay Protocol Fee
        if fee > 0 {
            let cpi_fee = Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.fee_recipient_vault.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(cpi_program, cpi_fee, signer_seeds),
                fee,
            )?;
        }

        task.is_completed = true;

        let contractor_agent = &mut ctx.accounts.contractor_agent;
        contractor_agent.active_tasks_count = contractor_agent
            .active_tasks_count
            .saturating_sub(1);
        contractor_agent.completed_tasks_count = contractor_agent
            .completed_tasks_count
            .checked_add(1)
            .ok_or(CookieJarError::MathOverflow)?;

        emit!(TaskCompletedEvent {
            task_id: task.task_id,
            contractor: task.contractor,
            net_payout,
            fee,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Resolve expired or disputed task by Oracle Authority.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        slash_to_employer: bool,
    ) -> Result<()> {
        let task = &mut ctx.accounts.task_escrow;
        require!(!task.is_completed, CookieJarError::TaskAlreadyCompleted);

        let clock = Clock::get()?;
        let is_timed_out = clock.unix_timestamp > task.deadline;
        require!(
            is_timed_out || task.is_disputed,
            CookieJarError::DisputeConditionsNotMet
        );

        let amount = task.reward_amount;
        let task_id_bytes = task.task_id;
        let vault_bump = task.vault_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"escrow_vault".as_ref(),
            task_id_bytes.as_ref(),
            &[vault_bump],
        ]];

        let target_account = if slash_to_employer {
            ctx.accounts.employer_token_account.to_account_info()
        } else {
            ctx.accounts.contractor_token_account.to_account_info()
        };

        let cpi_accounts = Transfer {
            from: ctx.accounts.escrow_vault.to_account_info(),
            to: target_account,
            authority: ctx.accounts.escrow_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
            amount,
        )?;

        task.is_completed = true;

        let contractor_agent = &mut ctx.accounts.contractor_agent;
        contractor_agent.active_tasks_count = contractor_agent
            .active_tasks_count
            .saturating_sub(1);

        emit!(TaskDisputeResolvedEvent {
            task_id: task.task_id,
            refunded_to_employer: slash_to_employer,
            amount,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }
}

// -------------------------------------------------------------------------
// Internal Accounting Logic
// -------------------------------------------------------------------------
impl cookie_jar::CookieJar {
    fn internal_accumulate_rewards(agent: &mut Account<AgentAccount>, current_time: i64) -> Result<()> {
        let time_delta = current_time.saturating_sub(agent.last_reward_block_time);
        if time_delta == 0 || agent.total_staked == 0 {
            agent.last_reward_block_time = current_time;
            return Ok(());
        }

        // Mindshare reward emission formula:
        // Reward rate = (mindshare_score * 10^9) / (time_constant_factor)
        // Accrued = Delta_T * (Score * Scale) / total_staked
        let reward_factor = (agent.mindshare_score as u128)
            .checked_mul(100) // Mindshare weight
            .ok_or(CookieJarError::MathOverflow)?;

        let newly_accrued = (time_delta as u128)
            .checked_mul(reward_factor)
            .ok_or(CookieJarError::MathOverflow)?
            .checked_mul(PRECISION)
            .ok_or(CookieJarError::MathOverflow)?
            .checked_div(agent.total_staked as u128)
            .unwrap_or(0);

        agent.acc_reward_per_share = agent
            .acc_reward_per_share
            .checked_add(newly_accrued)
            .ok_or(CookieJarError::MathOverflow)?;
        agent.last_reward_block_time = current_time;

        Ok(())
    }
}

// -------------------------------------------------------------------------
// Account Contexts & Validation
// -------------------------------------------------------------------------
#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ProtocolConfig::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub reward_mint: Account<'info, Mint>,
    /// CHECK: Protocol fee recipient vault/wallet
    pub fee_recipient: AccountInfo<'info>,
    /// CHECK: Public key for Cookie Mindshare Oracle attestation signer
    pub oracle_authority: AccountInfo<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub mod register_agent_accounts {
    use super::*;
    #[derive(Accounts)]
    #[instruction(agent_id: String)]
    pub struct RegisterAgent<'info> {
        #[account(
            init,
            payer = owner,
            space = 8 + AgentAccount::LEN,
            seeds = [b"agent", agent_id.as_bytes()],
            bump
        )]
        pub agent: Account<'info, AgentAccount>,
        #[account(
            init,
            payer = owner,
            seeds = [b"agent_vault", agent_id.as_bytes()],
            bump,
            token::mint = stake_mint,
            token::authority = agent_vault,
        )]
        pub agent_vault: Account<'info, TokenAccount>,
        pub stake_mint: Account<'info, Mint>,
        #[account(mut, seeds = [b"config"], bump = config.bump)]
        pub config: Account<'info, ProtocolConfig>,
        #[account(mut)]
        pub owner: Signer<'info>,
        pub system_program: Program<'info, System>,
        pub token_program: Program<'info, Token>,
        pub rent: Sysvar<'info, Rent>,
    }
}
pub use register_agent_accounts::*;

#[derive(Accounts)]
pub struct UpdateMindshareScore<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = oracle_authority @ CookieJarError::UnauthorizedOracle
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_bytes()],
        bump = agent.bump
    )]
    pub agent: Account<'info, AgentAccount>,
    pub oracle_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct StakeToAgent<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_bytes()],
        bump = agent.bump
    )]
    pub agent: Account<'info, AgentAccount>,
    #[account(
        mut,
        seeds = [b"agent_vault", agent.agent_id.as_bytes()],
        bump = agent.vault_bump
    )]
    pub agent_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserStakeRecord::LEN,
        seeds = [b"user_stake", agent.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_stake: Account<'info, UserStakeRecord>,
    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == agent_vault.mint
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UnstakeFromAgent<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_bytes()],
        bump = agent.bump
    )]
    pub agent: Account<'info, AgentAccount>,
    #[account(
        mut,
        seeds = [b"agent_vault", agent.agent_id.as_bytes()],
        bump = agent.vault_bump
    )]
    pub agent_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"user_stake", agent.key().as_ref(), user.key().as_ref()],
        bump = user_stake.bump,
        has_one = user @ CookieJarError::UnauthorizedSigner
    )]
    pub user_stake: Account<'info, UserStakeRecord>,
    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == agent_vault.mint
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimYield<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"agent", agent.agent_id.as_bytes()],
        bump = agent.bump
    )]
    pub agent: Account<'info, AgentAccount>,
    #[account(
        mut,
        seeds = [b"user_stake", agent.key().as_ref(), user.key().as_ref()],
        bump = user_stake.bump,
        has_one = user @ CookieJarError::UnauthorizedSigner
    )]
    pub user_stake: Account<'info, UserStakeRecord>,
    #[account(
        mut,
        constraint = rewards_pool_vault.mint == config.reward_mint
    )]
    pub rewards_pool_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = user_reward_token_account.owner == user.key(),
        constraint = user_reward_token_account.mint == config.reward_mint
    )]
    pub user_reward_token_account: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(task_id: [u8; 16])]
pub struct CreateTaskEscrow<'info> {
    #[account(
        init,
        payer = employer,
        space = 8 + TaskEscrow::LEN,
        seeds = [b"task", task_id.as_ref()],
        bump
    )]
    pub task_escrow: Account<'info, TaskEscrow>,
    #[account(
        init,
        payer = employer,
        seeds = [b"escrow_vault", task_id.as_ref()],
        bump,
        token::mint = escrow_mint,
        token::authority = escrow_vault
    )]
    pub escrow_vault: Account<'info, TokenAccount>,
    pub escrow_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"agent", contractor_agent.agent_id.as_bytes()],
        bump = contractor_agent.bump
    )]
    pub contractor_agent: Account<'info, AgentAccount>,
    /// CHECK: Contractor Solana recipient account
    pub contractor: AccountInfo<'info>,
    #[account(
        mut,
        constraint = employer_token_account.owner == employer.key(),
        constraint = employer_token_account.mint == escrow_mint.key()
    )]
    pub employer_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub employer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CompleteTask<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"task", task_escrow.task_id.as_ref()],
        bump = task_escrow.bump,
        has_one = employer @ CookieJarError::UnauthorizedSigner,
        has_one = contractor @ CookieJarError::UnauthorizedContractor
    )]
    pub task_escrow: Account<'info, TaskEscrow>,
    #[account(
        mut,
        seeds = [b"escrow_vault", task_escrow.task_id.as_ref()],
        bump = task_escrow.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"agent", contractor_agent.agent_id.as_bytes()],
        bump = contractor_agent.bump
    )]
    pub contractor_agent: Account<'info, AgentAccount>,
    /// CHECK: Verified via has_one on task_escrow
    pub contractor: AccountInfo<'info>,
    #[account(
        mut,
        constraint = contractor_token_account.owner == contractor.key()
    )]
    pub contractor_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = fee_recipient_vault.key() == config.fee_recipient
    )]
    pub fee_recipient_vault: Account<'info, TokenAccount>,
    pub employer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = oracle_authority @ CookieJarError::UnauthorizedOracle
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"task", task_escrow.task_id.as_ref()],
        bump = task_escrow.bump,
        has_one = employer @ CookieJarError::InvalidEmployerAccount,
        has_one = contractor @ CookieJarError::InvalidContractorAccount
    )]
    pub task_escrow: Account<'info, TaskEscrow>,
    #[account(
        mut,
        seeds = [b"escrow_vault", task_escrow.task_id.as_ref()],
        bump = task_escrow.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"agent", contractor_agent.agent_id.as_bytes()],
        bump = contractor_agent.bump
    )]
    pub contractor_agent: Account<'info, AgentAccount>,
    /// CHECK: Task employer
    #[account(mut)]
    pub employer: AccountInfo<'info>,
    /// CHECK: Task contractor
    #[account(mut)]
    pub contractor: AccountInfo<'info>,
    #[account(
        mut,
        constraint = employer_token_account.owner == employer.key()
    )]
    pub employer_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = contractor_token_account.owner == contractor.key()
    )]
    pub contractor_token_account: Account<'info, TokenAccount>,
    pub oracle_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -------------------------------------------------------------------------
// State Layouts
// -------------------------------------------------------------------------
#[account]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub reward_mint: Pubkey,
    pub fee_basis_points: u16,
    pub total_agents: u64,
    pub bump: u8,
}

impl ProtocolConfig {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 2 + 8 + 1;
}

#[account]
pub struct AgentAccount {
    pub owner: Pubkey,
    pub agent_id: String,
    pub metadata_uri: String,
    pub mindshare_score: u64,
    pub last_mindshare_update: i64,
    pub total_staked: u64,
    pub acc_reward_per_share: u128,
    pub last_reward_block_time: i64,
    pub active_tasks_count: u32,
    pub completed_tasks_count: u32,
    pub bump: u8,
    pub vault_bump: u8,
}

impl AgentAccount {
    pub const LEN: usize = 32 + (4 + MAX_AGENT_ID_LEN) + (4 + MAX_URI_LEN) + 8 + 8 + 8 + 16 + 8 + 4 + 4 + 1 + 1;
}

#[account]
pub struct UserStakeRecord {
    pub user: Pubkey,
    pub agent: Pubkey,
    pub staked_amount: u64,
    pub reward_debt: u128,
    pub pending_rewards: u64,
    pub bump: u8,
}

impl UserStakeRecord {
    pub const LEN: usize = 32 + 32 + 8 + 16 + 8 + 1;
}

#[account]
pub struct TaskEscrow {
    pub task_id: [u8; 16],
    pub employer: Pubkey,
    pub contractor: Pubkey,
    pub reward_amount: u64,
    pub deadline: i64,
    pub is_completed: bool,
    pub is_disputed: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl TaskEscrow {
    pub const LEN: usize = 16 + 32 + 32 + 8 + 8 + 1 + 1 + 1 + 1;
}

// -------------------------------------------------------------------------
// Events
// -------------------------------------------------------------------------
#[event]
pub struct ProtocolInitializedEvent {
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub reward_mint: Pubkey,
    pub fee_basis_points: u16,
    pub timestamp: i64,
}

#[event]
pub struct AgentRegisteredEvent {
    pub agent_id: String,
    pub owner: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct MindshareUpdatedEvent {
    pub agent_id: String,
    pub new_score: u64,
    pub timestamp: i64,
}

#[event]
pub struct StakeDepositedEvent {
    pub user: Pubkey,
    pub agent_id: String,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct StakeWithdrawnEvent {
    pub user: Pubkey,
    pub agent_id: String,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct YieldHarvestedEvent {
    pub user: Pubkey,
    pub agent_id: String,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct TaskEscrowCreatedEvent {
    pub task_id: [u8; 16],
    pub employer: Pubkey,
    pub contractor: Pubkey,
    pub reward_amount: u64,
    pub deadline: i64,
}

#[event]
pub struct TaskCompletedEvent {
    pub task_id: [u8; 16],
    pub contractor: Pubkey,
    pub net_payout: u64,
    pub fee: u64,
    pub timestamp: i64,
}

#[event]
pub struct TaskDisputeResolvedEvent {
    pub task_id: [u8; 16],
    pub refunded_to_employer: bool,
    pub amount: u64,
    pub timestamp: i64,
}

// -------------------------------------------------------------------------
// Error Codes
// -------------------------------------------------------------------------
#[error_code]
pub enum CookieJarError {
    #[msg("Fee basis points cannot exceed 1000 (10%)")]
    FeeTooHigh,
    #[msg("Provided string exceeds maximum allowed byte length")]
    InvalidStringLength,
    #[msg("Calculation overflow in checked arithmetic")]
    MathOverflow,
    #[msg("Transaction amount must be strictly positive")]
    ZeroAmount,
    #[msg("Insufficient staked balance for requested withdrawal")]
    InsufficientStake,
    #[msg("No yield accumulated for harvest at this checkpoint")]
    NoYieldToClaim,
    #[msg("Task duration must be at least 60 seconds")]
    TimeoutTooShort,
    #[msg("Task escrow has already been finalized or claimed")]
    TaskAlreadyCompleted,
    #[msg("Task is currently flagged in arbitration dispute")]
    TaskInDispute,
    #[msg("Conditions for dispute arbitration have not been met")]
    DisputeConditionsNotMet,
    #[msg("Signer does not match the authorized Oracle Authority")]
    UnauthorizedOracle,
    #[msg("Signer pubkey does not match authorized owner")]
    UnauthorizedSigner,
    #[msg("Caller is not the recognized task contractor")]
    UnauthorizedContractor,
    #[msg("Invalid employer token account specified")]
    InvalidEmployerAccount,
    #[msg("Invalid contractor token account specified")]
    InvalidContractorAccount,
}