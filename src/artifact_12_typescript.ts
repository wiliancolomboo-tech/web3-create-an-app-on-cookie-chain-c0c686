import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Cookiestream } from "../target/types/cookiestream";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("cookiestream integration tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Cookiestream as Program<Cookiestream>;
  const creator = anchor.web3.Keypair.generate();
  const operator = anchor.web3.Keypair.generate();
  const oracle = anchor.web3.Keypair.generate();

  let rewardMint: anchor.web3.Pubkey;
  let creatorTokenAccount: anchor.web3.Pubkey;
  let operatorTokenAccount: anchor.web3.Pubkey;
  let agentRegistryPda: anchor.web3.Pubkey;
  let vaultPda: anchor.web3.Pubkey;

  const agentId = "agent-cookie-zero-01";
  const targetMindshare = new anchor.BN(500); // 500 Mindshare units
  const ratePerMindshareUnit = new anchor.BN(10_000_000); // 0.01 tokens / unit / sec (1e9 scaled)
  const epochIntervalSeconds = new anchor.BN(2); // 2 second interval for test speed

  before(async () => {
    // Airdrop SOL
    for (const kp of [creator, operator, oracle]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Deploy Test SPL Mint
    rewardMint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      9
    );

    // Setup Token Accounts
    creatorTokenAccount = await createAccount(
      provider.connection,
      creator,
      rewardMint,
      creator.publicKey
    );

    operatorTokenAccount = await createAccount(
      provider.connection,
      operator,
      rewardMint,
      operator.publicKey
    );

    // Mint liquidity to creator
    await mintTo(
      provider.connection,
      creator,
      rewardMint,
      creatorTokenAccount,
      creator,
      1_000_000_000_000 // 1,000 tokens
    );

    // Derive PDAs
    [agentRegistryPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [
        Buffer.from("agent"),
        creator.publicKey.toBuffer(),
        Buffer.from(agentId),
      ],
      program.programId
    );

    [vaultPda] = anchor.web3.Pubkey.findProgramAddressSync(
      [Buffer.from("vault"), agentRegistryPda.toBuffer()],
      program.programId
    );
  });

  it("Initializes the Agent Registry PDA and Escrow Vault", async () => {
    await program.methods
      .initializeAgent(
        agentId,
        targetMindshare,
        ratePerMindshareUnit,
        epochIntervalSeconds
      )
      .accounts({
        creator: creator.publicKey,
        operator: operator.publicKey,
        oracle: oracle.publicKey,
        rewardMint: rewardMint,
        agentRegistry: agentRegistryPda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .rpc();

    const reg = await program.account.agentRegistry.fetch(agentRegistryPda);
    expect(reg.agentId).to.equal(agentId);
    expect(reg.targetMindshare.toNumber()).to.equal(500);
    expect(reg.oracle.toBase58()).to.equal(oracle.publicKey.toBase58());
  });

  it("Deposits funding into the Escrow Vault PDA", async () => {
    const depositAmount = new anchor.BN(500_000_000_000); // 500 tokens

    await program.methods
      .depositEscrow(depositAmount)
      .accounts({
        funder: creator.publicKey,
        agentRegistry: agentRegistryPda,
        rewardMint: rewardMint,
        vault: vaultPda,
        funderTokenAccount: creatorTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([creator])
      .rpc();

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBalance.amount)).to.equal(500_000_000_000);
  });

  it("Submits Mindshare metrics from authenticated Cookie Oracle", async () => {
    await new Promise((resolve) => setTimeout(resolve, 2100)); // Wait for epoch interval

    await program.methods
      .submitMindshareMetric(new anchor.BN(1), new anchor.BN(650))
      .accounts({
        oracleSigner: oracle.publicKey,
        agentRegistry: agentRegistryPda,
      })
      .signers([oracle])
      .rpc();

    const reg = await program.account.agentRegistry.fetch(agentRegistryPda);
    expect(reg.currentEpoch.toNumber()).to.equal(1);
    expect(reg.latestMindshare.toNumber()).to.equal(650);
  });

  it("Rejects Metric Submission from Unauthorized Signer", async () => {
    const imposter = anchor.web3.Keypair.generate();
    try {
      await program.methods
        .submitMindshareMetric(new anchor.BN(2), new anchor.BN(700))
        .accounts({
          oracleSigner: imposter.publicKey,
          agentRegistry: agentRegistryPda,
        })
        .signers([imposter])
        .rpc();
      expect.fail("Should have failed on unauthorized oracle check");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedOracle");
    }
  });

  it("Streams and Claims Dynamic Mindshare Payouts", async () => {
    await new Promise((resolve) => setTimeout(resolve, 2100));

    await program.methods
      .claimStreamedRewards()
      .accounts({
        caller: operator.publicKey,
        agentRegistry: agentRegistryPda,
        operator: operator.publicKey,
        vault: vaultPda,
        operatorTokenAccount: operatorTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([operator])
      .rpc();

    const operatorBal = await getAccount(provider.connection, operatorTokenAccount);
    expect(Number(operatorBal.amount)).to.be.greaterThan(0);
  });

  it("Slashing Invariant: Reclaims funds when underperforming threshold exceeded", async () => {
    // Feed 3 consecutive underperforming epochs
    for (let epoch = 2; epoch <= 4; epoch++) {
      await new Promise((resolve) => setTimeout(resolve, 2100));
      await program.methods
        .submitMindshareMetric(new anchor.BN(epoch), new anchor.BN(200)) // Below 500 target
        .accounts({
          oracleSigner: oracle.publicKey,
          agentRegistry: agentRegistryPda,
        })
        .signers([oracle])
        .rpc();
    }

    const reg = await program.account.agentRegistry.fetch(agentRegistryPda);
    expect(reg.underperformingEpochs).to.equal(3);

    // Creator triggers slashing reclamation
    const creatorBalBefore = (await getAccount(provider.connection, creatorTokenAccount)).amount;

    await program.methods
      .reclaimUnderperforming()
      .accounts({
        creator: creator.publicKey,
        agentRegistry: agentRegistryPda,
        vault: vaultPda,
        creatorTokenAccount: creatorTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([creator])
      .rpc();

    const creatorBalAfter = (await getAccount(provider.connection, creatorTokenAccount)).amount;
    expect(Number(creatorBalAfter)).to.be.greaterThan(Number(creatorBalBefore));
  });
});