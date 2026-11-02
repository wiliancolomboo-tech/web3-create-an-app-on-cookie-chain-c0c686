import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieJar } from "../target/types/cookie_jar";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import crypto from "crypto";

describe("CookieJar Protocol: Cookie Chain SVM Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieJar as Program<CookieJar>;

  const admin = anchor.web3.Keypair.generate();
  const oracle = anchor.web3.Keypair.generate();
  const employerAgent = anchor.web3.Keypair.generate();
  const contractorAgent = anchor.web3.Keypair.generate();
  const stakerUser = anchor.web3.Keypair.generate();

  let rewardMint: anchor.web3.Pubkey;
  let stakeMint: anchor.web3.Pubkey;
  let configPda: anchor.web3.Pubkey;
  let configBump: number;

  let feeRecipientVault: anchor.web3.Pubkey;
  let rewardsPoolVault: anchor.web3.Pubkey;

  const agentId = "agent-cookie-alpha-001";
  let agentPda: anchor.web3.Pubkey;
  let agentVaultPda: anchor.web3.Pubkey;
  let userStakePda: anchor.web3.Pubkey;
  let userStakeTokenAcc: anchor.web3.Pubkey;
  let userRewardTokenAcc: anchor.web3.Pubkey;

  const taskId = Array.from(crypto.randomBytes(16));
  let taskEscrowPda: anchor.web3.Pubkey;
  let escrowVaultPda: anchor.web3.Pubkey;
  let employerTokenAcc: anchor.web3.Pubkey;
  let contractorTokenAcc: anchor.web3.Pubkey;

  before(async () => {
    // Fund test wallets
    const airdropSigners = [admin, oracle, employerAgent, contractorAgent, stakerUser];
    for (const signer of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(
        signer.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create SPL Mints
    rewardMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    stakeMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    [configPda, configBump] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    feeRecipientVault = await createAccount(
      provider.connection,
      admin,
      rewardMint,
      admin.publicKey
    );

    rewardsPoolVault = await createAccount(
      provider.connection,
      admin,
      rewardMint,
      configPda
    );

    // Seed global reward pool
    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      rewardsPoolVault,
      admin,
      100_000_000_000
    );

    // Derive Agent and Staking PDAs
    [agentPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent"), Buffer.from(agentId)],
      program.programId
    );

    [agentVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent_vault"), Buffer.from(agentId)],
      program.programId
    );

    [userStakePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [
        Buffer.from("user_stake"),
        agentPda.toBuffer(),
        stakerUser.publicKey.toBuffer(),
      ],
      program.programId
    );

    userStakeTokenAcc = await createAccount(
      provider.connection,
      stakerUser,
      stakeMint,
      stakerUser.publicKey
    );

    userRewardTokenAcc = await createAccount(
      provider.connection,
      stakerUser,
      rewardMint,
      stakerUser.publicKey
    );

    // Mint stake tokens to user
    await mintTo(
      provider.connection,
      admin,
      stakeMint,
      userStakeTokenAcc,
      admin,
      50_000_000_000
    );

    // Escrow Accounts
    [taskEscrowPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("task"), Buffer.from(taskId)],
      program.programId
    );

    [escrowVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), Buffer.from(taskId)],
      program.programId
    );

    employerTokenAcc = await createAccount(
      provider.connection,
      employerAgent,
      rewardMint,
      employerAgent.publicKey
    );

    contractorTokenAcc = await createAccount(
      provider.connection,
      contractorAgent,
      rewardMint,
      contractorAgent.publicKey
    );

    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      employerTokenAcc,
      admin,
      10_000_000_000
    );
  });

  it("1. Initializes Protocol State successfully", async () => {
    const feeBps = 250; // 2.5% protocol fee
    const tx = await program.methods
      .initializeProtocol(feeBps)
      .accounts({
        config: configPda,
        rewardMint: rewardMint,
        feeRecipient: feeRecipientVault,
        oracleAuthority: oracle.publicKey,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    expect(tx).to.be.a("string");

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.feeBasisPoints).to.equal(250);
  });

  it("2. Registers an AI Agent with identity PDA", async () => {
    const metadataUri = "ipfs://bafkreiaa34cookiejaragentregistry74k2p4m5j";
    await program.methods
      .registerAgent(agentId, metadataUri)
      .accounts({
        agent: agentPda,
        agentVault: agentVaultPda,
        stakeMint: stakeMint,
        config: configPda,
        owner: contractorAgent.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([contractorAgent])
      .rpc();

    const agent = await program.account.agentAccount.fetch(agentPda);
    expect(agent.agentId).to.equal(agentId);
    expect(agent.mindshareScore.toNumber()).to.equal(0);
    expect(agent.totalStaked.toNumber()).to.equal(0);
  });

  it("3. Cookie Mindshare Oracle pushes updated score", async () => {
    const initialScore = new anchor.BN(8500); // 85.00 mindshare score
    await program.methods
      .updateMindshareScore(initialScore)
      .accounts({
        config: configPda,
        agent: agentPda,
        oracleAuthority: oracle.publicKey,
      })
      .signers([oracle])
      .rpc();

    const agent = await program.account.agentAccount.fetch(agentPda);
    expect(agent.mindshareScore.toNumber()).to.equal(8500);
  });

  it("4. Staker deposits capital into Agent Vault", async () => {
    const depositAmount = new anchor.BN(5_000_000_000); // 5000 tokens
    await program.methods
      .stakeToAgent(depositAmount)
      .accounts({
        agent: agentPda,
        agentVault: agentVaultPda,
        userStake: userStakePda,
        userTokenAccount: userStakeTokenAcc,
        user: stakerUser.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([stakerUser])
      .rpc();

    const agent = await program.account.agentAccount.fetch(agentPda);
    const userRecord = await program.account.userStakeRecord.fetch(userStakePda);

    expect(agent.totalStaked.toNumber()).to.equal(5_000_000_000);
    expect(userRecord.stakedAmount.toNumber()).to.equal(5_000_000_000);
  });

  it("5. Creates an A2A Task Escrow between employer and contractor", async () => {
    const taskReward = new anchor.BN(1_000_000_000); // 1000 tokens
    const timeoutSeconds = new anchor.BN(3600); // 1 hour

    await program.methods
      .createTaskEscrow(taskId, taskReward, timeoutSeconds)
      .accounts({
        taskEscrow: taskEscrowPda,
        escrowVault: escrowVaultPda,
        escrowMint: rewardMint,
        contractorAgent: agentPda,
        contractor: contractorAgent.publicKey,
        employerTokenAccount: employerTokenAcc,
        employer: employerAgent.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([employerAgent])
      .rpc();

    const task = await program.account.taskEscrow.fetch(taskEscrowPda);
    expect(task.rewardAmount.toNumber()).to.equal(1_000_000_000);
    expect(task.isCompleted).to.be.false;

    const agent = await program.account.agentAccount.fetch(agentPda);
    expect(agent.activeTasksCount).to.equal(1);
  });

  it("6. Completes A2A Task with protocol fee deduction", async () => {
    const employerBalBefore = await getAccount(provider.connection, employerTokenAcc);
    const feeBalBefore = await getAccount(provider.connection, feeRecipientVault);

    await program.methods
      .completeTask()
      .accounts({
        config: configPda,
        taskEscrow: taskEscrowPda,
        escrowVault: escrowVaultPda,
        contractorAgent: agentPda,
        contractor: contractorAgent.publicKey,
        contractorTokenAccount: contractorTokenAcc,
        feeRecipientVault: feeRecipientVault,
        employer: employerAgent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([employerAgent])
      .rpc();

    const contractorBal = await getAccount(provider.connection, contractorTokenAcc);
    const feeBalAfter = await getAccount(provider.connection, feeRecipientVault);
    const task = await program.account.taskEscrow.fetch(taskEscrowPda);

    // 1000 tokens escrowed: 2.5% fee = 25 tokens, 975 tokens to contractor
    expect(Number(contractorBal.amount)).to.equal(975_000_000);
    expect(Number(feeBalAfter.amount - feeBalBefore.amount)).to.equal(25_000_000);
    expect(task.isCompleted).to.be.true;

    const agent = await program.account.agentAccount.fetch(agentPda);
    expect(agent.activeTasksCount).to.equal(0);
    expect(agent.completedTasksCount).to.equal(1);
  });
});