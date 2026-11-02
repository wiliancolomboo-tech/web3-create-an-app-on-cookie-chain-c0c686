import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieAgent } from "../target/types/cookie_agent";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import * as nacl from "tweetnacl";

describe("CookieAgentProtocol (CAP) End-to-End QA Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieAgent as Program<CookieAgent>;

  const adminKeypair = Keypair.generate();
  const oracleKeypair = Keypair.generate(); // Cookie Oracle Signer
  const creatorKeypair = Keypair.generate();
  const userAlice = Keypair.generate();
  const userBob = Keypair.generate();

  let paymentTokenMint: PublicKey;
  let adminTreasuryAccount: PublicKey;
  let alicePaymentAccount: PublicKey;
  let bobPaymentAccount: PublicKey;
  let distributorPaymentAccount: PublicKey;

  const agentId = "cookie_agent_alpha_7";
  const initialMindshare = new anchor.BN(50_000); // 50,000 units
  const basePrice = new anchor.BN(1_000_000); // 1.0 payment token per base unit

  let configPda: PublicKey;
  let vaultPda: PublicKey;
  let mintPda: PublicKey;
  let escrowPda: PublicKey;
  let aliceStakePda: PublicKey;
  let bobStakePda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [adminKeypair, creatorKeypair, userAlice, userBob]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Create Base Payment Token (USDC-equivalent)
    paymentTokenMint = await createMint(
      provider.connection,
      adminKeypair,
      adminKeypair.publicKey,
      null,
      6
    );

    // Initialize Token Accounts
    adminTreasuryAccount = await createAccount(
      provider.connection,
      adminKeypair,
      paymentTokenMint,
      adminKeypair.publicKey
    );

    alicePaymentAccount = await createAccount(
      provider.connection,
      userAlice,
      paymentTokenMint,
      userAlice.publicKey
    );

    bobPaymentAccount = await createAccount(
      provider.connection,
      userBob,
      paymentTokenMint,
      userBob.publicKey
    );

    distributorPaymentAccount = await createAccount(
      provider.connection,
      adminKeypair,
      paymentTokenMint,
      adminKeypair.publicKey
    );

    // Seed payment balances (10,000 tokens each)
    const initialBalance = 10_000 * 1_000_000;
    await mintTo(provider.connection, adminKeypair, paymentTokenMint, alicePaymentAccount, adminKeypair, initialBalance);
    await mintTo(provider.connection, adminKeypair, paymentTokenMint, bobPaymentAccount, adminKeypair, initialBalance);
    await mintTo(provider.connection, adminKeypair, paymentTokenMint, distributorPaymentAccount, adminKeypair, 100_000 * 1_000_000);

    // PDA derivations
    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from(agentId)], program.programId);
    [mintPda] = PublicKey.findProgramAddressSync([Buffer.from("mint"), Buffer.from(agentId)], program.programId);
    [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), Buffer.from(agentId)], program.programId);
    [aliceStakePda] = PublicKey.findProgramAddressSync([Buffer.from("stake"), Buffer.from(agentId), userAlice.publicKey.toBuffer()], program.programId);
    [bobStakePda] = PublicKey.findProgramAddressSync([Buffer.from("stake"), Buffer.from(agentId), userBob.publicKey.toBuffer()], program.programId);
  });

  it("1. Initializes the Global Cookie Agent Protocol", async () => {
    const feeBps = 250; // 2.5%
    await program.methods
      .initializeProtocol(oracleKeypair.publicKey, feeBps)
      .accounts({
        config: configPda,
        admin: adminKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([adminKeypair])
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(adminKeypair.publicKey.toBase58());
    expect(configAccount.cookieOracleAuthority.toBase58()).to.equal(oracleKeypair.publicKey.toBase58());
    expect(configAccount.feeBasisPoints).to.equal(feeBps);
  });

  it("2. Registers an Autonomous Agent Vault for Cookie AI Agent", async () => {
    await program.methods
      .initializeAgentVault(agentId, initialMindshare, basePrice)
      .accounts({
        vault: vaultPda,
        agentTokenMint: mintPda,
        paymentMint: paymentTokenMint,
        vaultEscrow: escrowPda,
        config: configPda,
        creator: creatorKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([creatorKeypair])
      .rpc();

    const vaultAccount = await program.account.agentVault.fetch(vaultPda);
    expect(vaultAccount.agentId).to.equal(agentId);
    expect(vaultAccount.mindshareScore.toNumber()).to.equal(50_000);
    expect(vaultAccount.totalStakedTokens.toNumber()).to.equal(0);
  });

  it("3. Ingests Ed25519-Signed Mindshare Metrics from Cookie Oracle", async () => {
    const newMindshare = new anchor.BN(85_000); // Mindshare increased
    const currentClock = Math.floor(Date.now() / 1000);

    const messageBuffer = Buffer.from(`cookie:${agentId}:${newMindshare.toString()}:${currentClock}`);
    const ed25519Sig = nacl.sign.detached(messageBuffer, oracleKeypair.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: oracleKeypair.publicKey.toBytes(),
      message: messageBuffer,
      signature: ed25519Sig,
    });

    const updateIx = await program.methods
      .updateMindshare(agentId, newMindshare, new anchor.BN(currentClock))
      .accounts({
        config: configPda,
        vault: vaultPda,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        caller: adminKeypair.publicKey,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(updateIx);
    await sendAndConfirmTransaction(provider.connection, tx, [adminKeypair], {
      commitment: "confirmed",
    });

    const vaultAccount = await program.account.agentVault.fetch(vaultPda);
    expect(vaultAccount.mindshareScore.toNumber()).to.equal(85_000);
  });

  it("4. Prevents Mindshare update if signature is invalid or forged", async () => {
    const maliciousSigner = Keypair.generate();
    const forgedMindshare = new anchor.BN(999_999);
    const currentClock = Math.floor(Date.now() / 1000);

    const messageBuffer = Buffer.from(`cookie:${agentId}:${forgedMindshare.toString()}:${currentClock}`);
    const forgedSig = nacl.sign.detached(messageBuffer, maliciousSigner.secretKey);

    const forgedEd25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: maliciousSigner.publicKey.toBytes(),
      message: messageBuffer,
      signature: forgedSig,
    });

    const updateIx = await program.methods
      .updateMindshare(agentId, forgedMindshare, new anchor.BN(currentClock))
      .accounts({
        config: configPda,
        vault: vaultPda,
        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        caller: adminKeypair.publicKey,
      })
      .instruction();

    const tx = new Transaction().add(forgedEd25519Ix).add(updateIx);

    try {
      await sendAndConfirmTransaction(provider.connection, tx, [adminKeypair]);
      expect.fail("Expected transaction to revert on unauthorized oracle signer");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedOracleSigner");
    }
  });

  it("5. Allows Alice and Bob to stake along the dynamic bonding curve", async () => {
    const aliceDeposit = new anchor.BN(1_000_000); // 1 Token
    const aliceAta = await createAccount(
      provider.connection,
      userAlice,
      mintPda,
      userAlice.publicKey
    );

    await program.methods
      .stakeAgent(aliceDeposit)
      .accounts({
        vault: vaultPda,
        agentTokenMint: mintPda,
        paymentMint: paymentTokenMint,
        vaultEscrow: escrowPda,
        userStake: aliceStakePda,
        userPaymentAccount: alicePaymentAccount,
        userAgentTokenAccount: aliceAta,
        user: userAlice.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([userAlice])
      .rpc();

    const aliceStake = await program.account.userStakePosition.fetch(aliceStakePda);
    expect(aliceStake.stakedAmount.toNumber()).to.be.greaterThan(0);

    // Bob stakes 2 Tokens
    const bobDeposit = new anchor.BN(2_000_000);
    const bobAta = await createAccount(
      provider.connection,
      userBob,
      mintPda,
      userBob.publicKey
    );

    await program.methods
      .stakeAgent(bobDeposit)
      .accounts({
        vault: vaultPda,
        agentTokenMint: mintPda,
        paymentMint: paymentTokenMint,
        vaultEscrow: escrowPda,
        userStake: bobStakePda,
        userPaymentAccount: bobPaymentAccount,
        userAgentTokenAccount: bobAta,
        user: userBob.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([userBob])
      .rpc();

    const bobStake = await program.account.userStakePosition.fetch(bobStakePda);
    expect(bobStake.stakedAmount.toNumber()).to.be.greaterThan(0);

    const vaultAccount = await program.account.agentVault.fetch(vaultPda);
    expect(vaultAccount.totalStakedTokens.toNumber()).to.equal(
      aliceStake.stakedAmount.add(bobStake.stakedAmount).toNumber()
    );
  });

  it("6. Distributes yield with protocol fee withholding & updates accumulator", async () => {
    const yieldAmount = new anchor.BN(300_000); // 0.3 tokens
    const adminTreasuryBefore = await getAccount(provider.connection, adminTreasuryAccount);

    await program.methods
      .distributeYield(yieldAmount)
      .accounts({
        config: configPda,
        vault: vaultPda,
        vaultEscrow: escrowPda,
        adminTreasury: adminTreasuryAccount,
        distributorPaymentAccount: distributorPaymentAccount,
        distributor: adminKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([adminKeypair])
      .rpc();

    const adminTreasuryAfter = await getAccount(provider.connection, adminTreasuryAccount);
    const expectedFee = 300_000 * 0.025; // 2.5% fee = 7,500
    expect(Number(adminTreasuryAfter.amount) - Number(adminTreasuryBefore.amount)).to.equal(expectedFee);

    const vaultAccount = await program.account.agentVault.fetch(vaultPda);
    expect(vaultAccount.accumulatedRewardPerShare.toString()).to.not.equal("0");
  });

  it("7. Permits Alice to claim proportional dividend yield without precision loss", async () => {
    const aliceBalanceBefore = await getAccount(provider.connection, alicePaymentAccount);

    await program.methods
      .claimRewards()
      .accounts({
        vault: vaultPda,
        vaultEscrow: escrowPda,
        userStake: aliceStakePda,
        userPaymentAccount: alicePaymentAccount,
        user: userAlice.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userAlice])
      .rpc();

    const aliceBalanceAfter = await getAccount(provider.connection, alicePaymentAccount);
    const delta = Number(aliceBalanceAfter.amount) - Number(aliceBalanceBefore.amount);
    expect(delta).to.be.greaterThan(0);

    // Double claim in immediate succession must fail with NoRewardsToClaim
    try {
      await program.methods
        .claimRewards()
        .accounts({
          vault: vaultPda,
          vaultEscrow: escrowPda,
          userStake: aliceStakePda,
          userPaymentAccount: alicePaymentAccount,
          user: userAlice.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userAlice])
        .rpc();
      expect.fail("Should have failed to claim zero rewards");
    } catch (err: any) {
      expect(err.toString()).to.include("NoRewardsToClaim");
    }
  });
});