import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieChainApp } from "../target/types/cookie_chain_app";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("CookieAgentFi Protocol - Cookie Chain SVM Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieChainApp as Program<CookieChainApp>;

  const oracleKeypair = Keypair.generate();
  const agentTreasury = Keypair.generate();
  const traderUser = Keypair.generate();

  const agentId = "cookie-agent-007";
  const metadataUri = "https://api.cookie.fun/agent/007/metadata.json";

  let globalConfigPda: PublicKey;
  let agentPda: PublicKey;
  let bondingPoolPda: PublicKey;
  let poolVaultPda: PublicKey;
  let userStakePda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    const airdropSig1 = await provider.connection.requestAirdrop(oracleKeypair.publicKey, 2 * LAMPORTS_PER_SOL);
    const airdropSig2 = await provider.connection.requestAirdrop(traderUser.publicKey, 10 * LAMPORTS_PER_SOL);
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature: airdropSig1,
      ...latestBlockhash,
    });
    await provider.connection.confirmTransaction({
      signature: airdropSig2,
      ...latestBlockhash,
    });

    [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), Buffer.from(agentId)],
      program.programId
    );

    [bondingPoolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-pool"), agentPda.toBuffer()],
      program.programId
    );

    [poolVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool-vault"), agentPda.toBuffer()],
      program.programId
    );

    [userStakePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user-stake"), bondingPoolPda.toBuffer(), traderUser.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes protocol global configuration", async () => {
    const protocolFeeBps = 200; // 2%

    await program.methods
      .initialize(protocolFeeBps, oracleKeypair.publicKey)
      .accounts({
        config: globalConfigPda,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(globalConfigPda);
    expect(configAccount.admin.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(configAccount.oracleAuthority.toBase58()).to.equal(oracleKeypair.publicKey.toBase58());
    expect(configAccount.protocolFeeBps).to.equal(200);
    expect(configAccount.totalAgents.toNumber()).to.equal(0);
  });

  it("2. Registers an AI Agent with autonomous bonding pool", async () => {
    const agentFeeBps = 500; // 5%

    await program.methods
      .registerAgent(agentId, metadataUri, agentFeeBps)
      .accounts({
        config: globalConfigPda,
        agent: agentPda,
        pool: bondingPoolPda,
        poolVault: poolVaultPda,
        creator: provider.wallet.publicKey,
        treasury: agentTreasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const agentData = await program.account.agentAccount.fetch(agentPda);
    expect(agentData.agentId).to.equal(agentId);
    expect(agentData.treasury.toBase58()).to.equal(agentTreasury.publicKey.toBase58());
    expect(agentData.mindshareScore.toNumber()).to.equal(10000);

    const poolData = await program.account.bondingPool.fetch(bondingPoolPda);
    expect(poolData.agent.toBase58()).to.equal(agentPda.toBase58());
    expect(poolData.totalSupply.toNumber()).to.equal(0);
  });

  it("3. Cranks Cookie Mindshare Oracle update from verified authority", async () => {
    const newMindshareScore = new anchor.BN(850000); // 85% Mindshare
    const newRank = 3;
    const currentEpoch = new anchor.BN(1);

    await program.methods
      .updateMindshare(newMindshareScore, newRank, currentEpoch)
      .accounts({
        config: globalConfigPda,
        agent: agentPda,
        pool: bondingPoolPda,
        oracleAuthority: oracleKeypair.publicKey,
      })
      .signers([oracleKeypair])
      .rpc();

    const agentData = await program.account.agentAccount.fetch(agentPda);
    expect(agentData.mindshareScore.toNumber()).to.equal(850000);
    expect(agentData.mindshareRank).to.equal(3);

    const poolData = await program.account.bondingPool.fetch(bondingPoolPda);
    // Dynamic Multiplier: 1_000_000 + (850_000 / 2) = 1_425_000
    expect(poolData.dynamicMultiplier.toNumber()).to.equal(1425000);
  });

  it("4. Buys AI Attention shares via dynamic bonding curve", async () => {
    const buyDeposit = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const minSharesOut = new anchor.BN(100_000);

    const initialTreasuryBalance = await provider.connection.getBalance(agentTreasury.publicKey);

    await program.methods
      .buyShares(buyDeposit, minSharesOut)
      .accounts({
        config: globalConfigPda,
        agent: agentPda,
        pool: bondingPoolPda,
        poolVault: poolVaultPda,
        userStake: userStakePda,
        agentTreasury: agentTreasury.publicKey,
        user: traderUser.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([traderUser])
      .rpc();

    const userStake = await program.account.userStake.fetch(userStakePda);
    expect(userStake.shares.toNumber()).to.be.greaterThan(0);

    const postTreasuryBalance = await provider.connection.getBalance(agentTreasury.publicKey);
    // 5% of 1 SOL = 0.05 SOL transferred to Agent Treasury
    expect(postTreasuryBalance - initialTreasuryBalance).to.equal(0.05 * LAMPORTS_PER_SOL);
  });

  it("5. Sells Attention shares with dynamic liquidity unwinding", async () => {
    const userStakeBefore = await program.account.userStake.fetch(userStakePda);
    const sharesToSell = userStakeBefore.shares.div(new anchor.BN(2));
    const minSolOut = new anchor.BN(1000);

    const userSolBefore = await provider.connection.getBalance(traderUser.publicKey);

    await program.methods
      .sellShares(sharesToSell, minSolOut)
      .accounts({
        agent: agentPda,
        pool: bondingPoolPda,
        poolVault: poolVaultPda,
        userStake: userStakePda,
        user: traderUser.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([traderUser])
      .rpc();

    const userStakeAfter = await program.account.userStake.fetch(userStakePda);
    expect(userStakeAfter.shares.toNumber()).to.be.lessThan(userStakeBefore.shares.toNumber());

    const userSolAfter = await provider.connection.getBalance(traderUser.publicKey);
    expect(userSolAfter).to.be.greaterThan(userSolBefore);
  });
});