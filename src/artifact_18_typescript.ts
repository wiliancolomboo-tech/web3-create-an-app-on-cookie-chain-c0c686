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
import crypto from "crypto";

describe("CookiePulse: AI Agent Mindshare Protocol Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookiePulse as Program<CookiePulse>;

  const authority = anchor.web3.Keypair.generate();
  const oracle = anchor.web3.Keypair.generate();
  const developer = anchor.web3.Keypair.generate();
  const sponsor = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;
  let sponsorTokenAccount: anchor.web3.PublicKey;
  let agentPayoutAccount: anchor.web3.PublicKey;

  const agentUuid = crypto.randomBytes(32);
  const poolId = new anchor.BN(101);
  const epoch = new anchor.BN(1);
  const initialFunding = new anchor.BN(10_000_000_000); // 10,000 COOKIE tokens
  const rewardForEpoch = new anchor.BN(1_000_000_000); // 1,000 COOKIE tokens

  before(async () => {
    // Air-drop devnet SOL to test keypairs
    for (const kp of [authority, oracle, developer, sponsor]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    // Create mint (represents COOKIE token)
    mint = await createMint(
      provider.connection,
      sponsor,
      sponsor.publicKey,
      null,
      6
    );

    // Associated Token Accounts
    sponsorTokenAccount = await createAccount(
      provider.connection,
      sponsor,
      mint,
      sponsor.publicKey
    );

    agentPayoutAccount = await createAccount(
      provider.connection,
      developer,
      mint,
      developer.publicKey
    );

    // Mint initial tokens to sponsor
    await mintTo(
      provider.connection,
      sponsor,
      mint,
      sponsorTokenAccount,
      sponsor.publicKey,
      100_000_000_000
    );
  });

  it("1. Initializes Protocol State Configuration", async () => {
    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cookie_pulse_config")],
      program.programId
    );

    await program.methods
      .initialize()
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        oracleAuthority: oracle.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(configAccount.oracleAuthority.toBase58()).to.equal(oracle.publicKey.toBase58());
    expect(configAccount.poolCount.toNumber()).to.equal(0);
  });

  it("2. Registers an Autonomous AI Agent with Execution PDA", async () => {
    const [agentPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentUuid],
      program.programId
    );

    await program.methods
      .registerAgent(Array.from(agentUuid))
      .accounts({
        agent: agentPda,
        developer: developer.publicKey,
        payoutVault: agentPayoutAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([developer])
      .rpc();

    const agentAccount = await program.account.agentRegistration.fetch(agentPda);
    expect(agentAccount.developer.toBase58()).to.equal(developer.publicKey.toBase58());
    expect(agentAccount.payoutVault.toBase58()).to.equal(agentPayoutAccount.toBase58());
    expect(agentAccount.isActive).to.be.true;
    expect(agentAccount.totalEarned.toNumber()).to.equal(0);
  });

  it("3. Creates and Funds an Incentive Streaming Pool", async () => {
    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cookie_pulse_config")],
      program.programId
    );

    const [poolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), poolId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .createAndFundPool(poolId, initialFunding)
      .accounts({
        config: configPda,
        pool: poolPda,
        mint: mint,
        vault: vaultPda,
        sponsorTokenAccount: sponsorTokenAccount,
        sponsor: sponsor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([sponsor])
      .rpc();

    const poolAccount = await program.account.incentivePool.fetch(poolPda);
    expect(poolAccount.poolId.toNumber()).to.equal(poolId.toNumber());
    expect(poolAccount.currentEpoch.toNumber()).to.equal(1);

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBalance.amount)).to.equal(initialFunding.toNumber());
  });

  it("4. Oracle Commits Verified Mindshare Scores for Epoch 1", async () => {
    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cookie_pulse_config")],
      program.programId
    );

    const [poolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), poolId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [attributionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("attribution"),
        poolId.toArrayLike(Buffer, "le", 8),
        epoch.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const attributionBatch = [
      {
        agentId: Array.from(agentUuid),
        mindshareScore: new anchor.BN(800_000), // 80% mindshare
      },
      {
        agentId: Array.from(crypto.randomBytes(32)),
        mindshareScore: new anchor.BN(200_000), // 20% mindshare
      },
    ];

    await program.methods
      .commitAttribution(epoch, rewardForEpoch, attributionBatch)
      .accounts({
        config: configPda,
        pool: poolPda,
        attribution: attributionPda,
        oracleAuthority: oracle.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([oracle])
      .rpc();

    const attrib = await program.account.epochAttribution.fetch(attributionPda);
    expect(attrib.totalMindshareScore.toNumber()).to.equal(1_000_000);
    expect(attrib.rewardAmount.toNumber()).to.equal(rewardForEpoch.toNumber());
  });

  it("5. Claims Pro-Rata Yield and Verifies Atomic Spl-Token Disbursement", async () => {
    const [poolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), poolId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [agentPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentUuid],
      program.programId
    );

    const [attributionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("attribution"),
        poolId.toArrayLike(Buffer, "le", 8),
        epoch.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [receiptPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("receipt"),
        poolId.toArrayLike(Buffer, "le", 8),
        epoch.toArrayLike(Buffer, "le", 8),
        agentUuid,
      ],
      program.programId
    );

    const devInitialBalance = await getAccount(provider.connection, agentPayoutAccount);

    await program.methods
      .claimRewards(epoch)
      .accounts({
        pool: poolPda,
        attribution: attributionPda,
        agent: agentPda,
        claimReceipt: receiptPda,
        poolVault: vaultPda,
        payoutVault: agentPayoutAccount,
        caller: developer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([developer])
      .rpc();

    // 80% of 1,000,000,000 is 800,000,000
    const devFinalBalance = await getAccount(provider.connection, agentPayoutAccount);
    const expectedReceived = 800_000_000;
    expect(Number(devFinalBalance.amount) - Number(devInitialBalance.amount)).to.equal(expectedReceived);

    const receipt = await program.account.claimReceipt.fetch(receiptPda);
    expect(receipt.claimedAmount.toNumber()).to.equal(expectedReceived);

    const agent = await program.account.agentRegistration.fetch(agentPda);
    expect(agent.totalEarned.toNumber()).to.equal(expectedReceived);
  });

  it("6. Revert Test: Prevents Double-Claiming for Same Epoch", async () => {
    const [poolPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), poolId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [agentPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentUuid],
      program.programId
    );
    const [attributionPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("attribution"),
        poolId.toArrayLike(Buffer, "le", 8),
        epoch.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [receiptPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("receipt"),
        poolId.toArrayLike(Buffer, "le", 8),
        epoch.toArrayLike(Buffer, "le", 8),
        agentUuid,
      ],
      program.programId
    );

    try {
      await program.methods
        .claimRewards(epoch)
        .accounts({
          pool: poolPda,
          attribution: attributionPda,
          agent: agentPda,
          claimReceipt: receiptPda,
          poolVault: vaultPda,
          payoutVault: agentPayoutAccount,
          caller: developer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([developer])
        .rpc();
      expect.fail("Double claim should fail");
    } catch (err: any) {
      // The receipt PDA already exists, failing init constraint
      expect(err.toString()).to.include("already in use");
    }
  });
});