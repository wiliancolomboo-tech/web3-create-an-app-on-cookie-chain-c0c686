import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookiePulse } from "../target/types/cookie_pulse";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("CookiePulse Anchor Lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookiePulse as Program<CookiePulse>;

  const authority = anchor.web3.Keypair.generate();
  const oracleSigner = anchor.web3.Keypair.generate();
  const treasury = anchor.web3.Keypair.generate();
  const creator = anchor.web3.Keypair.generate();
  const agentOwner = anchor.web3.Keypair.generate();
  const delegator = anchor.web3.Keypair.generate();

  let mint: anchor.web3.Pubkey;
  let creatorTokenAccount: anchor.web3.Pubkey;
  let agentTokenAccount: anchor.web3.Pubkey;
  let treasuryTokenAccount: anchor.web3.Pubkey;

  const agentId = "agent-cookie-42";
  const bountyId = "bounty-metric-99";
  const protocolFeeBps = 500; // 5%

  before(async () => {
    // Fund test keypairs
    for (const kp of [authority, oracleSigner, creator, agentOwner, delegator]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      const latestBlock = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlock,
      });
    }

    // Initialize Mint & Token Accounts
    mint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      6
    );

    creatorTokenAccount = await createAccount(
      provider.connection,
      creator,
      mint,
      creator.publicKey
    );

    agentTokenAccount = await createAccount(
      provider.connection,
      agentOwner,
      mint,
      agentOwner.publicKey
    );

    treasuryTokenAccount = await createAccount(
      provider.connection,
      authority,
      mint,
      treasury.publicKey
    );

    // Mint 10,000 SPL units to creator
    await mintTo(
      provider.connection,
      creator,
      mint,
      creatorTokenAccount,
      creator,
      10_000_000_000
    );
  });

  it("1. Initializes the Global Protocol Configuration PDA", async () => {
    const [configPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    await program.methods
      .initialize(protocolFeeBps)
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        oracleSigner: oracleSigner.publicKey,
        treasury: treasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(configAccount.oracleSigner.toBase58()).to.equal(oracleSigner.publicKey.toBase58());
    expect(configAccount.protocolFeeBps).to.equal(500);
  });

  it("2. Registers an AI Agent with Attention Metadata", async () => {
    const [agentPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent"), Buffer.from(agentId)],
      program.programId
    );

    await program.methods
      .registerAgent(agentId, "https://cookie3.co/agents/agent-42.json")
      .accounts({
        agent: agentPda,
        owner: agentOwner.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([agentOwner])
      .rpc();

    const agentAccount = await program.account.agentAccount.fetch(agentPda);
    expect(agentAccount.agentId).to.equal(agentId);
    expect(agentAccount.mindshareScore.toNumber()).to.equal(0);
  });

  it("3. Oracle pushes verified Cookie Chain Mindshare Score", async () => {
    const [configPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    const [agentPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent"), Buffer.from(agentId)],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);
    const certifiedMindshare = new anchor.BN(8500); // Mindshare index 85.00

    await program.methods
      .updateMindshare(agentId, certifiedMindshare, new anchor.BN(now))
      .accounts({
        config: configPda,
        agent: agentPda,
        oracleSigner: oracleSigner.publicKey,
      })
      .signers([oracleSigner])
      .rpc();

    const agentAccount = await program.account.agentAccount.fetch(agentPda);
    expect(agentAccount.mindshareScore.toNumber()).to.equal(8500);
  });

  it("4. Creates an Escrowed Mindshare Bounty", async () => {
    const [bountyPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("bounty"), Buffer.from(bountyId)],
      program.programId
    );
    const [vaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(bountyId)],
      program.programId
    );

    const rewardAmount = new anchor.BN(1_000_000_000); // 1,000 units
    const minMindshare = new anchor.BN(7000); // Needs >= 70.00 Mindshare
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour

    await program.methods
      .createBounty(bountyId, rewardAmount, minMindshare, deadline)
      .accounts({
        bounty: bountyPda,
        escrowVault: vaultPda,
        mint: mint,
        creatorTokenAccount: creatorTokenAccount,
        creator: creator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .rpc();

    const vaultInfo = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultInfo.amount)).to.equal(1_000_000_000);
  });

  it("5. Allows AI Agent to claim bounty with mindshare qualification", async () => {
    const [configPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    const [bountyPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("bounty"), Buffer.from(bountyId)],
      program.programId
    );
    const [vaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(bountyId)],
      program.programId
    );
    const [agentPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent"), Buffer.from(agentId)],
      program.programId
    );

    await program.methods
      .claimBounty(bountyId)
      .accounts({
        config: configPda,
        bounty: bountyPda,
        escrowVault: vaultPda,
        agent: agentPda,
        owner: agentOwner.publicKey,
        mint: mint,
        agentTokenAccount: agentTokenAccount,
        treasuryTokenAccount: treasuryTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agentOwner])
      .rpc();

    // Verification: 5% of 1,000 = 50 fee, 950 agent payout
    const agentTokenInfo = await getAccount(provider.connection, agentTokenAccount);
    const treasuryTokenInfo = await getAccount(provider.connection, treasuryTokenAccount);

    expect(Number(agentTokenInfo.amount)).to.equal(950_000_000);
    expect(Number(treasuryTokenInfo.amount)).to.equal(50_000_000);

    const bountyData = await program.account.bountyEscrow.fetch(bountyPda);
    expect(bountyData.isClaimed).to.be.true;
  });

  it("6. Rejects double claim attempts (Reentrancy / Double-spend prevention)", async () => {
    const [configPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    const [bountyPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("bounty"), Buffer.from(bountyId)],
      program.programId
    );
    const [vaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(bountyId)],
      program.programId
    );
    const [agentPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent"), Buffer.from(agentId)],
      program.programId
    );

    try {
      await program.methods
        .claimBounty(bountyId)
        .accounts({
          config: configPda,
          bounty: bountyPda,
          escrowVault: vaultPda,
          agent: agentPda,
          owner: agentOwner.publicKey,
          mint: mint,
          agentTokenAccount: agentTokenAccount,
          treasuryTokenAccount: treasuryTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agentOwner])
        .rpc();
      expect.fail("Double claim should have thrown error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("BountyClosed");
    }
  });

  it("7. Delegator stakes capital to back AI Agent performance pool", async () => {
    const [agentPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("agent"), Buffer.from(agentId)],
      program.programId
    );
    const [stakePda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("stake"), agentPda.toBuffer(), delegator.publicKey.toBuffer()],
      program.programId
    );

    const stakeAmount = new anchor.BN(1 * anchor.web3.LAMPORTS_PER_SOL);

    await program.methods
      .stakeAgent(stakeAmount)
      .accounts({
        agent: agentPda,
        stakeRecord: stakePda,
        delegator: delegator.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([delegator])
      .rpc();

    const stakeRecord = await program.account.delegatorStake.fetch(stakePda);
    expect(stakeRecord.stakedAmount.toNumber()).to.equal(1 * anchor.web3.LAMPORTS_PER_SOL);
  });
});