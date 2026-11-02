import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieStream } from "../target/types/cookie_stream";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("cookie-stream integration test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieStream as Program<CookieStream>;
  const connection = provider.connection;

  const admin = anchor.web3.Keypair.generate();
  const oracleAuthority = anchor.web3.Keypair.generate();
  const staker = anchor.web3.Keypair.generate();

  let stakeMint: anchor.web3.Pubkey;
  let rewardMint: anchor.web3.Pubkey;
  let stakerStakeTokenAccount: anchor.web3.Pubkey;
  let stakerRewardTokenAccount: anchor.web3.Pubkey;

  const agentId = "agent-eliza-01";
  const metadataUri = "https://api.cookie.fun/agent/eliza-01.json";

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [admin, oracleAuthority, staker]) {
      const sig = await connection.requestAirdrop(actor.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
    }

    // Create Mints
    stakeMint = await createMint(connection, admin, admin.publicKey, null, 6);
    rewardMint = await createMint(connection, admin, admin.publicKey, null, 6);

    // Create User Token Accounts
    stakerStakeTokenAccount = await createAccount(connection, staker, stakeMint, staker.publicKey);
    stakerRewardTokenAccount = await createAccount(connection, staker, rewardMint, staker.publicKey);

    // Mint Tokens
    await mintTo(connection, admin, stakeMint, stakerStakeTokenAccount, admin, 1_000_000_000); // 1,000 SPL
  });

  it("1. Initializes CookieStream Protocol Global Config", async () => {
    const [configPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("cookie_config")],
      program.programId
    );

    await program.methods
      .initializeProtocol(250) // 2.5% protocol fee BPS
      .accounts({
        config: configPda,
        oracleAuthority: oracleAuthority.publicKey,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.oracleAuthority.toBase58()).to.equal(oracleAuthority.publicKey.toBase58());
    expect(configAccount.protocolFeeBps).to.equal(250);
  });

  it("2. Registers a New AI Agent with Isolated PDAs", async () => {
    const [agentStatePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent_metrics"), Buffer.from(agentId)],
      program.programId
    );
    const [stakeVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("stake_vault"), Buffer.from(agentId)],
      program.programId
    );
    const [rewardVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("reward_vault"), Buffer.from(agentId)],
      program.programId
    );

    await program.methods
      .registerAgent(agentId, metadataUri)
      .accounts({
        agentState: agentStatePda,
        stakeVault: stakeVaultPda,
        rewardVault: rewardVaultPda,
        stakeMint: stakeMint,
        rewardMint: rewardMint,
        creator: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const agentState = await program.account.agentMindshare.fetch(agentStatePda);
    expect(agentState.agentId).to.equal(agentId);
    expect(agentState.mindshareBps.toNumber()).to.equal(1000);
    expect(agentState.totalStaked.toNumber()).to.equal(0);
  });

  it("3. Funds Reward Vault with $COOKIE Emission Budget", async () => {
    const [rewardVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("reward_vault"), Buffer.from(agentId)],
      program.programId
    );
    const adminRewardAccount = await createAccount(connection, admin, rewardMint, admin.publicKey);
    await mintTo(connection, admin, rewardMint, adminRewardAccount, admin, 500_000_000);

    const [agentStatePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent_metrics"), Buffer.from(agentId)],
      program.programId
    );

    await program.methods
      .fundRewardVault(agentId, new anchor.BN(500_000_000))
      .accounts({
        agentState: agentStatePda,
        rewardVault: rewardVaultPda,
        funderTokenAccount: adminRewardAccount,
        rewardMint: rewardMint,
        funder: admin.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const vaultInfo = await getAccount(connection, rewardVaultPda);
    expect(Number(vaultInfo.amount)).to.equal(500_000_000);
  });

  it("4. Staker Deposits Capital into AI Agent Vault", async () => {
    const stakeAmount = new anchor.BN(100_000_000); // 100 SPL
    const [agentStatePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent_metrics"), Buffer.from(agentId)],
      program.programId
    );
    const [stakeVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("stake_vault"), Buffer.from(agentId)],
      program.programId
    );
    const [userStakePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("user_stake"), Buffer.from(agentId), staker.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .stake(agentId, stakeAmount)
      .accounts({
        agentState: agentStatePda,
        stakeVault: stakeVaultPda,
        userStake: userStakePda,
        userTokenAccount: stakerStakeTokenAccount,
        user: staker.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([staker])
      .rpc();

    const userStake = await program.account.userStake.fetch(userStakePda);
    expect(userStake.amount.toNumber()).to.equal(stakeAmount.toNumber());

    const agent = await program.account.agentMindshare.fetch(agentStatePda);
    expect(agent.totalStaked.toNumber()).to.equal(stakeAmount.toNumber());
  });

  it("5. Oracle Updates Mindshare Score (Dynamic Yield Acceleration)", async () => {
    const [configPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("cookie_config")],
      program.programId
    );
    const [agentStatePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent_metrics"), Buffer.from(agentId)],
      program.programId
    );

    // Fast-forward wait 2 seconds
    await new Promise((res) => setTimeout(res, 2000));

    const newMindshareBps = new anchor.BN(4500); // Agent Mindshare skyrockets to 45.00%
    const nonce = new anchor.BN(1);

    await program.methods
      .updateMindshare(agentId, newMindshareBps, nonce)
      .accounts({
        config: configPda,
        agentState: agentStatePda,
        oracleAuthority: oracleAuthority.publicKey,
      })
      .signers([oracleAuthority])
      .rpc();

    const agent = await program.account.agentMindshare.fetch(agentStatePda);
    expect(agent.mindshareBps.toNumber()).to.equal(4500);
    expect(agent.accRewardPerShare.toString()).to.not.equal("0");
  });

  it("6. Staker Claims Yield with Dynamic Mindshare Multiplier", async () => {
    const [agentStatePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent_metrics"), Buffer.from(agentId)],
      program.programId
    );
    const [rewardVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("reward_vault"), Buffer.from(agentId)],
      program.programId
    );
    const [userStakePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("user_stake"), Buffer.from(agentId), staker.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimRewards(agentId)
      .accounts({
        agentState: agentStatePda,
        rewardVault: rewardVaultPda,
        userStake: userStakePda,
        userRewardAccount: stakerRewardTokenAccount,
        owner: staker.publicKey,
        user: staker.publicKey,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([staker])
      .rpc();

    const rewardAccountInfo = await getAccount(connection, stakerRewardTokenAccount);
    expect(Number(rewardAccountInfo.amount)).to.be.greaterThan(0);
  });
});