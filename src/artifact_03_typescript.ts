import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { CookieJar } from "../target/types/cookie_jar";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";

describe("Cookie Jar Protocol Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieJar as Program<CookieJar>;

  const admin = Keypair.generate();
  const oracle = Keypair.generate();
  const sponsor = Keypair.generate();
  const agentOwner = Keypair.generate();
  const treasuryOwner = Keypair.generate();

  let tokenMint: PublicKey;
  let sponsorTokenAccount: PublicKey;
  let agentPayoutTokenAccount: PublicKey;
  let treasuryTokenAccount: PublicKey;
  let agentFunderTokenAccount: PublicKey;

  let configPda: PublicKey;
  let agentRecordPda: PublicKey;
  let stakingVaultPda: PublicKey;
  let escrowPda: PublicKey;
  let escrowVaultPda: PublicKey;
  let epochPda: PublicKey;

  const feeBps = 250; // 2.5% fee
  const escrowId = new BN(1001);
  const targetEpoch = new BN(42);
  const bountyAmount = new BN(100_000_000); // 100 Tokens
  const initialAgentStake = new BN(5_000_000); // 5 Tokens

  before(async () => {
    // Fund actors with SOL
    for (const kp of [admin, oracle, sponsor, agentOwner, treasuryOwner]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      const latestBlockHash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: sig,
      });
    }

    // Create reward token mint (6 decimals)
    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create Token Accounts
    sponsorTokenAccount = await createAccount(provider.connection, sponsor, tokenMint, sponsor.publicKey);
    agentPayoutTokenAccount = await createAccount(provider.connection, agentOwner, tokenMint, agentOwner.publicKey);
    treasuryTokenAccount = await createAccount(provider.connection, treasuryOwner, tokenMint, treasuryOwner.publicKey);
    agentFunderTokenAccount = await createAccount(provider.connection, agentOwner, tokenMint, agentOwner.publicKey);

    // Mint tokens to sponsor and agent owner
    await mintTo(provider.connection, admin, tokenMint, sponsorTokenAccount, admin, 1_000_000_000);
    await mintTo(provider.connection, admin, tokenMint, agentFunderTokenAccount, admin, 50_000_000);

    // Derive PDAs
    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    [agentRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentOwner.publicKey.toBuffer()],
      program.programId
    );
    [stakingVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("staking_vault"), agentRecordPda.toBuffer()],
      program.programId
    );
    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), sponsor.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [escrowVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), escrowPda.toBuffer()],
      program.programId
    );
    [epochPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("epoch"), targetEpoch.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  });

  it("1. Initializes global protocol configuration", async () => {
    await program.methods
      .initializeProtocol(feeBps, oracle.publicKey)
      .accountsPartial({
        admin: admin.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.oracleSigner.toBase58()).to.equal(oracle.publicKey.toBase58());
    expect(configAccount.protocolFeeBps).to.equal(feeBps);
  });

  it("2. Registers an AI Agent and initializes staking vault", async () => {
    await program.methods
      .registerAgent("agent_cookie_alpha", "https://cookie3.co/agents/alpha.json")
      .accountsPartial({
        agentOwner: agentOwner.publicKey,
        agentRecord: agentRecordPda,
        stakingMint: tokenMint,
        stakingVault: stakingVaultPda,
        config: configPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([agentOwner])
      .rpc();

    const agent = await program.account.agentRecord.fetch(agentRecordPda);
    expect(agent.agentId).to.equal("agent_cookie_alpha");
    expect(agent.isActive).to.be.true;
    expect(agent.stakedAmount.toNumber()).to.equal(0);
  });

  it("3. Stakes collateral for registered AI Agent", async () => {
    await program.methods
      .stakeCollateral(initialAgentStake)
      .accountsPartial({
        funder: agentOwner.publicKey,
        agentRecord: agentRecordPda,
        stakingVault: stakingVaultPda,
        funderTokenAccount: agentFunderTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agentOwner])
      .rpc();

    const agent = await program.account.agentRecord.fetch(agentRecordPda);
    const vaultBal = await getAccount(provider.connection, stakingVaultPda);
    expect(agent.stakedAmount.toNumber()).to.equal(initialAgentStake.toNumber());
    expect(Number(vaultBal.amount)).to.equal(initialAgentStake.toNumber());
  });

  it("4. Creates a Sponsor Campaign Escrow Vault", async () => {
    await program.methods
      .createEscrow(escrowId, bountyAmount, targetEpoch)
      .accountsPartial({
        sponsor: sponsor.publicKey,
        mint: tokenMint,
        bountyEscrow: escrowPda,
        escrowVault: escrowVaultPda,
        sponsorTokenAccount: sponsorTokenAccount,
        config: configPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([sponsor])
      .rpc();

    const escrow = await program.account.bountyEscrow.fetch(escrowPda);
    expect(escrow.totalAmount.toNumber()).to.equal(bountyAmount.toNumber());
    expect(escrow.remainingAmount.toNumber()).to.equal(bountyAmount.toNumber());
    expect(escrow.isSettled).to.be.false;
  });

  it("5. Oracle publishes epoch Mindshare telemetry", async () => {
    const totalMindshare = new BN(1_000_000); // 1M total mindshare points
    await program.methods
      .submitMindshareEpoch(targetEpoch, totalMindshare, [])
      .accountsPartial({
        oracleAuthority: oracle.publicKey,
        config: configPda,
        epochState: epochPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();

    const epoch = await program.account.epochState.fetch(epochPda);
    expect(epoch.finalized).to.be.true;
    expect(epoch.totalMindshare.toNumber()).to.equal(totalMindshare.toNumber());
  });

  it("6. Oracle registers agent Mindshare score (50% share)", async () => {
    const agentScore = new BN(500_000); // 500k points = 50% of 1M
    await program.methods
      .updateAgentMetric(targetEpoch, agentScore)
      .accountsPartial({
        oracleAuthority: oracle.publicKey,
        config: configPda,
        epochState: epochPda,
        agentRecord: agentRecordPda,
      })
      .signers([oracle])
      .rpc();

    const agent = await program.account.agentRecord.fetch(agentRecordPda);
    expect(agent.mindshareScore.toNumber()).to.equal(500_000);
    expect(agent.lastEpochUpdated.toNumber()).to.equal(targetEpoch.toNumber());
  });

  it("7. Settles bounty payout with fee deduction", async () => {
    const preAgentBalance = Number((await getAccount(provider.connection, agentPayoutTokenAccount)).amount);
    const preTreasuryBalance = Number((await getAccount(provider.connection, treasuryTokenAccount)).amount);

    await program.methods
      .settleAgentBounty()
      .accountsPartial({
        caller: admin.publicKey,
        config: configPda,
        bountyEscrow: escrowPda,
        escrowVault: escrowVaultPda,
        epochState: epochPda,
        agentRecord: agentRecordPda,
        agentPayoutAccount: agentPayoutTokenAccount,
        protocolTreasuryVault: treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    // 50% of 100M = 50M gross reward
    // Fee = 2.5% of 50M = 1.25M
    // Net = 50M - 1.25M = 48.75M (48,750,000)
    const postAgentBalance = Number((await getAccount(provider.connection, agentPayoutTokenAccount)).amount);
    const postTreasuryBalance = Number((await getAccount(provider.connection, treasuryTokenAccount)).amount);

    expect(postAgentBalance - preAgentBalance).to.equal(48_750_000);
    expect(postTreasuryBalance - preTreasuryBalance).to.equal(1_250_000);

    const escrow = await program.account.bountyEscrow.fetch(escrowPda);
    expect(escrow.remainingAmount.toNumber()).to.equal(50_000_000);
  });

  it("8. Slashes faulty agent upon malicious metric violation", async () => {
    const slashAmount = new BN(2_000_000); // Slash 2 Tokens
    const reasonCode = 101; // Sybil / Artificial Impression Manipulation

    await program.methods
      .slashFaultyAgent(slashAmount, reasonCode)
      .accountsPartial({
        oracleAuthority: oracle.publicKey,
        config: configPda,
        agentRecord: agentRecordPda,
        stakingVault: stakingVaultPda,
        protocolTreasuryVault: treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([oracle])
      .rpc();

    const agent = await program.account.agentRecord.fetch(agentRecordPda);
    expect(agent.stakedAmount.toNumber()).to.equal(initialAgentStake.toNumber() - slashAmount.toNumber());
    expect(agent.slashedAmount.toNumber()).to.equal(slashAmount.toNumber());
    expect(agent.isActive).to.be.true; // 3M remains, above 1M min threshold
  });
});