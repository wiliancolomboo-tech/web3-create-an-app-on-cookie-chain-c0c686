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
import { assert, expect } from "chai";

describe("CookieJAR Protocol QA Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieJar as Program<CookieJar>;
  const connection = provider.connection;

  const protocolAuthority = anchor.web3.Keypair.generate();
  const oracleAuthority = anchor.web3.Keypair.generate();
  const agentKeypair = anchor.web3.Keypair.generate();
  const delegator = anchor.web3.Keypair.generate();

  let tokenMint: anchor.web3.Pubkey;
  let protocolConfigPda: anchor.web3.Pubkey;
  let rewardVaultPda: anchor.web3.Pubkey;
  let agentVaultPda: anchor.web3.Pubkey;
  let delegationRecordPda: anchor.web3.Pubkey;
  let delegatorAta: anchor.web3.Pubkey;

  const INITIAL_MINT_SUPPLY = 100_000_000_000_000n; // 100,000 COOKIE (6 dec)
  const STAKE_AMOUNT = 5_000_000_000n; // 5,000 COOKIE
  const REWARD_BUDGET = 500_000_000n; // 500 COOKIE

  before(async () => {
    // Fund test wallets
    for (const kp of [protocolAuthority, oracleAuthority, agentKeypair, delegator]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      });
    }

    // Initialize Mint
    tokenMint = await createMint(
      connection,
      protocolAuthority,
      protocolAuthority.publicKey,
      null,
      6
    );

    // Derive PDAs
    [protocolConfigPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [rewardVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );

    [agentVaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent"), agentKeypair.publicKey.toBuffer()],
      program.programId
    );

    [delegationRecordPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("delegation"), agentVaultPda.toBuffer(), delegator.publicKey.toBuffer()],
      program.programId
    );

    // Delegator ATA setup
    delegatorAta = await createAccount(connection, delegator, tokenMint, delegator.publicKey);
    await mintTo(connection, protocolAuthority, tokenMint, delegatorAta, protocolAuthority, INITIAL_MINT_SUPPLY);
  });

  it("1. Initializes Protocol successfully with parameters", async () => {
    const epochDuration = new anchor.BN(86400); // 1 day
    const minStake = new anchor.BN(100_000_000); // 100 COOKIE
    const alphaBps = 6000; // 60% stake, 40% mindshare

    await program.methods
      .initializeProtocol(oracleAuthority.publicKey, epochDuration, minStake, alphaBps)
      .accounts({
        authority: protocolAuthority.publicKey,
        tokenMint: tokenMint,
        config: protocolConfigPda,
        rewardVault: rewardVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([protocolAuthority])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(protocolConfigPda);
    expect(configAccount.authority.toBase58()).to.equal(protocolAuthority.publicKey.toBase58());
    expect(configAccount.oracleAuthority.toBase58()).to.equal(oracleAuthority.publicKey.toBase58());
    expect(configAccount.currentEpoch.toNumber()).to.equal(1);
    expect(configAccount.alphaWeightBps).to.equal(6000);
  });

  it("2. Registers an AI Agent with IPFS metadata URI", async () => {
    const metadataUri = new Uint8Array(64);
    Buffer.from("ipfs://QmZtmD2qt8fQgdfDgSmx6uZB7CjtVvN2RuvMBNPTiiCX7B").copy(metadataUri);

    await program.methods
      .registerAgent(Array.from(metadataUri))
      .accounts({
        agentSigner: agentKeypair.publicKey,
        agentVault: agentVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([agentKeypair])
      .rpc();

    const agent = await program.account.agentVault.fetch(agentVaultPda);
    expect(agent.agentWallet.toBase58()).to.equal(agentKeypair.publicKey.toBase58());
    expect(agent.totalStake.toNumber()).to.equal(0);
    expect(agent.isSlashed).to.be.false;
  });

  it("3. Delegates stake behind Agent and updates vault token balances", async () => {
    await program.methods
      .delegateStake(new anchor.BN(STAKE_AMOUNT.toString()))
      .accounts({
        delegator: delegator.publicKey,
        agentVault: agentVaultPda,
        delegation: delegationRecordPda,
        config: protocolConfigPda,
        rewardVault: rewardVaultPda,
        delegatorTokenAccount: delegatorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([delegator])
      .rpc();

    const agent = await program.account.agentVault.fetch(agentVaultPda);
    const delegation = await program.account.delegationRecord.fetch(delegationRecordPda);
    const vaultAta = await getAccount(connection, rewardVaultPda);

    expect(agent.totalStake.toString()).to.equal(STAKE_AMOUNT.toString());
    expect(delegation.shares.toString()).to.equal(STAKE_AMOUNT.toString());
    expect(vaultAta.amount.toString()).to.equal(STAKE_AMOUNT.toString());
  });

  it("4. Rejects Oracle telemetry updates from unauthorized signers", async () => {
    const unauthorizedSigner = anchor.web3.Keypair.generate();
    await connection.requestAirdrop(unauthorizedSigner.publicKey, 10 ** 9);

    try {
      await program.methods
        .updateMindshareMetrics(8500)
        .accounts({
          oracleSigner: unauthorizedSigner.publicKey,
          config: protocolConfigPda,
          agentVault: agentVaultPda,
        })
        .signers([unauthorizedSigner])
        .rpc();
      assert.fail("Oracle update should have failed authorization");
    } catch (err: any) {
      expect(err.message).to.include("Unauthorized");
    }
  });

  it("5. Updates Cookie Mindshare Score from authorized Oracle relayer", async () => {
    const mindshareBps = 7500; // 75.00% Attention Score

    await program.methods
      .updateMindshareMetrics(mindshareBps)
      .accounts({
        oracleSigner: oracleAuthority.publicKey,
        config: protocolConfigPda,
        agentVault: agentVaultPda,
      })
      .signers([oracleAuthority])
      .rpc();

    const agent = await program.account.agentVault.fetch(agentVaultPda);
    expect(agent.mindshareScore).to.equal(7500);
    expect(agent.lastUpdatedEpoch.toNumber()).to.equal(1);
  });

  it("6. Settles Epoch #1, distributes rewards according to MVWAP logic", async () => {
    // Fund Reward Vault with inflation emission
    await mintTo(connection, protocolAuthority, tokenMint, rewardVaultPda, protocolAuthority, REWARD_BUDGET);

    const [epochStatePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("epoch"), new anchor.BN(1).toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .settleEpoch(new anchor.BN(1), new anchor.BN(REWARD_BUDGET.toString()))
      .accounts({
        authority: protocolAuthority.publicKey,
        config: protocolConfigPda,
        epochState: epochStatePda,
        agentVault: agentVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([protocolAuthority])
      .rpc();

    const agent = await program.account.agentVault.fetch(agentVaultPda);
    const config = await program.account.protocolConfig.fetch(protocolConfigPda);

    expect(agent.accumulated_rewards_per_share.toString()).to.not.equal("0");
    expect(config.currentEpoch.toNumber()).to.equal(2);
  });

  it("7. Delegator claims accrued epoch rewards", async () => {
    const preBalance = (await getAccount(connection, delegatorAta)).amount;

    await program.methods
      .claimRewards()
      .accounts({
        delegator: delegator.publicKey,
        config: protocolConfigPda,
        agentVault: agentVaultPda,
        delegation: delegationRecordPda,
        rewardVault: rewardVaultPda,
        delegatorTokenAccount: delegatorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([delegator])
      .rpc();

    const postBalance = (await getAccount(connection, delegatorAta)).amount;
    expect(postBalance > preBalance).to.be.true;
  });
});