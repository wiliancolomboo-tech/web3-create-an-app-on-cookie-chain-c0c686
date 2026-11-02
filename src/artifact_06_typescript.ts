import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieMind } from "../target/types/cookie_mind";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("CookieMind Protocol Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieMind as Program<CookieMind>;

  const admin = Keypair.generate();
  const oracleKeeper = Keypair.generate();
  const treasury = Keypair.generate();
  const agentCreator = Keypair.generate();
  const trader = Keypair.generate();
  const sponsor = Keypair.generate();

  const agentUuid = "agent-cookie-swarm-007";
  const metadataUri = "https://cookie.fun/api/agent/cookie-swarm-007.json";

  let configPda: PublicKey;
  let agentPda: PublicKey;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let mintKeypair: Keypair;
  let traderAta: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    const accounts = [admin, oracleKeeper, agentCreator, trader, sponsor];
    for (const acc of accounts) {
      const sig = await provider.connection.requestAirdrop(
        acc.publicKey,
        15 * LAMPORTS_PER_SOL
      );
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), Buffer.from(agentUuid)],
      program.programId
    );

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding_pool"), Buffer.from(agentUuid)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(agentUuid)],
      program.programId
    );

    mintKeypair = Keypair.generate();
  });

  it("1. Initializes the Global Protocol Configuration", async () => {
    const tx = await program.methods
      .initializeProtocol(oracleKeeper.publicKey, treasury.publicKey)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    expect(tx).to.be.a("string");

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.cookieOracleAuthority.toBase58()).to.equal(
      oracleKeeper.publicKey.toBase58()
    );
    expect(configAccount.totalAgentsRegistered.toNumber()).to.equal(0);
  });

  it("2. Registers an AI Agent with Dynamic Bonding Curve & Token Mint", async () => {
    const initialVirtualSol = new anchor.BN(5 * LAMPORTS_PER_SOL);
    const initialVirtualTokens = new anchor.BN(1_000_000).mul(
      new anchor.BN(10).pow(new anchor.BN(9))
    ); // 1,000,000 MSHR

    await program.methods
      .registerAgent(
        agentUuid,
        metadataUri,
        initialVirtualSol,
        initialVirtualTokens
      )
      .accounts({
        config: configPda,
        agent: agentPda,
        bondingPool: poolPda,
        tokenMint: mintKeypair.publicKey,
        reserveVault: vaultPda,
        creator: agentCreator.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([agentCreator, mintKeypair])
      .rpc();

    const agent = await program.account.agentAccount.fetch(agentPda);
    expect(agent.agentUuid).to.equal(agentUuid);
    expect(agent.owner.toBase58()).to.equal(agentCreator.publicKey.toBase58());
    expect(agent.mindshareBps).to.equal(0);
    expect(agent.sentimentIndex).to.equal(5000);

    const pool = await program.account.bondingPoolAccount.fetch(poolPda);
    expect(pool.tokenMint.toBase58()).to.equal(
      mintKeypair.publicKey.toBase58()
    );
    expect(pool.virtualSolReserves.toString()).to.equal(
      initialVirtualSol.toString()
    );
  });

  it("3. Ingests Real-time Cookie Mindshare Metrics from Oracle Keeper", async () => {
    const targetMindshareBps = 750; // 7.50% Mindshare
    const sentimentScore = 8200; // 82.00% Bullish Sentiment

    await program.methods
      .updateMindshareMetrics(agentUuid, targetMindshareBps, sentimentScore)
      .accounts({
        config: configPda,
        agent: agentPda,
        cookieOracleAuthority: oracleKeeper.publicKey,
      })
      .signers([oracleKeeper])
      .rpc();

    const agent = await program.account.agentAccount.fetch(agentPda);
    expect(agent.mindshareBps).to.equal(750);
    expect(agent.sentimentIndex).to.equal(8200);
  });

  it("4. Rejects Mindshare update from unauthorized signer", async () => {
    const rogueKeypair = Keypair.generate();
    try {
      await program.methods
        .updateMindshareMetrics(agentUuid, 9999, 9999)
        .accounts({
          config: configPda,
          agent: agentPda,
          cookieOracleAuthority: rogueKeypair.publicKey,
        })
        .signers([rogueKeypair])
        .rpc();
      expect.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedOracle");
    }
  });

  it("5. Executes Mindshare Token Purchase along Dynamic Bonding Curve", async () => {
    // Create ATA for trader
    traderAta = await createAssociatedTokenAccount(
      provider.connection,
      trader,
      mintKeypair.publicKey,
      trader.publicKey
    );

    const solDeposit = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const minTokensOut = new anchor.BN(1);

    const initialTreasuryBalance = await provider.connection.getBalance(
      treasury.publicKey
    );

    await program.methods
      .buyTokens(agentUuid, solDeposit, minTokensOut)
      .accounts({
        config: configPda,
        agent: agentPda,
        bondingPool: poolPda,
        tokenMint: mintKeypair.publicKey,
        reserveVault: vaultPda,
        feeRecipient: treasury.publicKey,
        buyerTokenAccount: traderAta,
        buyer: trader.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader])
      .rpc();

    const tokenBalance = await getAccount(provider.connection, traderAta);
    expect(Number(tokenBalance.amount)).to.be.greaterThan(0);

    const finalTreasuryBalance = await provider.connection.getBalance(
      treasury.publicKey
    );
    expect(finalTreasuryBalance).to.be.greaterThan(initialTreasuryBalance);
  });

  it("6. Sells Portion of Mindshare Tokens with Slippage Guard", async () => {
    const tokenBalanceBefore = await getAccount(
      provider.connection,
      traderAta
    );
    const tokensToSell = new anchor.BN(tokenBalanceBefore.amount.toString()).div(
      new anchor.BN(2)
    );
    const minSolExpected = new anchor.BN(100_000); // 0.0001 SOL floor

    const tx = await program.methods
      .sellTokens(agentUuid, tokensToSell, minSolExpected)
      .accounts({
        config: configPda,
        agent: agentPda,
        bondingPool: poolPda,
        tokenMint: mintKeypair.publicKey,
        reserveVault: vaultPda,
        feeRecipient: treasury.publicKey,
        sellerTokenAccount: traderAta,
        seller: trader.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader])
      .rpc();

    expect(tx).to.be.a("string");

    const tokenBalanceAfter = await getAccount(provider.connection, traderAta);
    expect(Number(tokenBalanceAfter.amount)).to.equal(
      Number(tokenBalanceBefore.amount) - Number(tokensToSell)
    );
  });

  it("7. Fosters Agent Milestone Escrow and Settles Based on Mindshare", async () => {
    const escrowId = new anchor.BN(1);
    const bountyAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);
    const targetMindshareBps = 700; // Agent currently has 750 bps
    const deadlineTimestamp = new anchor.BN(
      Math.floor(Date.now() / 1000) + 3600
    );

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        Buffer.from(agentUuid),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Fund milestone escrow
    await program.methods
      .createEscrow(
        agentUuid,
        escrowId,
        targetMindshareBps,
        deadlineTimestamp,
        bountyAmount
      )
      .accounts({
        agent: agentPda,
        bondingPool: poolPda,
        escrow: escrowPda,
        funder: sponsor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsor])
      .rpc();

    const escrowAccount = await program.account.performanceEscrowAccount.fetch(
      escrowPda
    );
    expect(escrowAccount.isSettled).to.be.false;
    expect(escrowAccount.bountyAmount.toString()).to.equal(
      bountyAmount.toString()
    );

    // Release escrow because agent mindshare (750) >= target (700)
    const creatorBalBefore = await provider.connection.getBalance(
      agentCreator.publicKey
    );

    await program.methods
      .releaseEscrow(agentUuid, escrowId)
      .accounts({
        agent: agentPda,
        escrow: escrowPda,
        beneficiary: agentCreator.publicKey,
        caller: sponsor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sponsor])
      .rpc();

    const escrowAfter = await program.account.performanceEscrowAccount.fetch(
      escrowPda
    );
    expect(escrowAfter.isSettled).to.be.true;

    const creatorBalAfter = await provider.connection.getBalance(
      agentCreator.publicKey
    );
    expect(creatorBalAfter - creatorBalBefore).to.equal(2 * LAMPORTS_PER_SOL);
  });
});