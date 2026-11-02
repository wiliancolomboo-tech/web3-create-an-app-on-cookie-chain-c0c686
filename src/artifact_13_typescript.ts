import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieStream } from "../target/types/cookie_stream";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import crypto from "crypto";

describe("cookie_stream: Production Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieStream as Program<CookieStream>;
  const authority = provider.wallet as anchor.Wallet;
  const keeper = anchor.web3.Keypair.generate();
  const unauthorizedUser = anchor.web3.Keypair.generate();

  let quoteMint: anchor.web3.PublicKey;
  let userQuoteAta: anchor.web3.PublicKey;
  let globalConfigPda: anchor.web3.PublicKey;
  let globalConfigBump: number;

  const agentId = Array.from(crypto.randomBytes(32));

  before(async () => {
    // Airdrop SOL to Keeper & Unauthorized User
    const sig1 = await provider.connection.requestAirdrop(keeper.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(unauthorizedUser.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    // Create Quote SPL Token (USDC/COOKIE mock)
    quoteMint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      6
    );

    userQuoteAta = await createAccount(
      provider.connection,
      authority.payer,
      quoteMint,
      authority.publicKey
    );

    // Mint 10,000 Quote Tokens to Authority
    await mintTo(
      provider.connection,
      authority.payer,
      quoteMint,
      userQuoteAta,
      authority.payer,
      10_000_000_000
    );

    [globalConfigPda, globalConfigBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      program.programId
    );
  });

  it("1. Initializes global protocol configuration", async () => {
    const protocolFeeBps = 100; // 1%

    await program.methods
      .initializeProtocol(protocolFeeBps)
      .accounts({
        globalConfig: globalConfigPda,
        authority: authority.publicKey,
        keeperAuthority: keeper.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.globalConfig.fetch(globalConfigPda);
    expect(config.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(config.keeperAuthority.toBase58()).to.equal(keeper.publicKey.toBase58());
    expect(config.protocolFeeBps).to.equal(protocolFeeBps);
    expect(config.totalAgentsRegistered.toNumber()).to.equal(0);
  });

  it("2. Registers an AI Agent with Cookie Mindshare index", async () => {
    const initialMindshare = new anchor.BN(10_000); // 1.0x

    const [agentVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("agent_vault"), Buffer.from(agentId)],
      program.programId
    );

    const [bondingReservePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bonding_reserve"), Buffer.from(agentId)],
      program.programId
    );

    await program.methods
      .registerAgent(agentId, initialMindshare)
      .accounts({
        creator: authority.publicKey,
        globalConfig: globalConfigPda,
        agentVault: agentVaultPda,
        quoteMint: quoteMint,
        bondingReserve: bondingReservePda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vault = await program.account.agentVault.fetch(agentVaultPda);
    expect(vault.creator.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(vault.mindshareScore.toNumber()).to.equal(10_000);
    expect(vault.circulatingShares.toNumber()).to.equal(0);
  });

  it("3. Keeper updates agent Cookie Mindshare within bounded delta threshold", async () => {
    const [agentVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("agent_vault"), Buffer.from(agentId)],
      program.programId
    );

    const currentTimestamp = Math.floor(Date.now() / 1000);
    // +400 BPS (4.0% increase, allowed since limit is 500 BPS)
    const validMindshareUpdate = new anchor.BN(10_400);

    await program.methods
      .updateMindshare(validMindshareUpdate, new anchor.BN(currentTimestamp))
      .accounts({
        globalConfig: globalConfigPda,
        keeperAuthority: keeper.publicKey,
        agentVault: agentVaultPda,
      })
      .signers([keeper])
      .rpc();

    const vault = await program.account.agentVault.fetch(agentVaultPda);
    expect(vault.mindshareScore.toNumber()).to.equal(10_400);
  });

  it("4. Rejects Mindshare updates exceeding delta guard (> 500 BPS)", async () => {
    const [agentVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("agent_vault"), Buffer.from(agentId)],
      program.programId
    );

    const currentTimestamp = Math.floor(Date.now() / 1000);
    // +2000 BPS (20.0% sudden spike attempt)
    const maliciousUpdate = new anchor.BN(12_480);

    try {
      await program.methods
        .updateMindshare(maliciousUpdate, new anchor.BN(currentTimestamp))
        .accounts({
          globalConfig: globalConfigPda,
          keeperAuthority: keeper.publicKey,
          agentVault: agentVaultPda,
        })
        .signers([keeper])
        .rpc();
      expect.fail("Expected MindshareDeltaExceeded error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("MindshareDeltaExceeded");
    }
  });

  it("5. Rejects unauthorized keeper updates", async () => {
    const [agentVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("agent_vault"), Buffer.from(agentId)],
      program.programId
    );

    const currentTimestamp = Math.floor(Date.now() / 1000);
    const validUpdate = new anchor.BN(10_500);

    try {
      await program.methods
        .updateMindshare(validUpdate, new anchor.BN(currentTimestamp))
        .accounts({
          globalConfig: globalConfigPda,
          keeperAuthority: unauthorizedUser.publicKey,
          agentVault: agentVaultPda,
        })
        .signers([unauthorizedUser])
        .rpc();
      expect.fail("Expected Unauthorized keeper error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("Unauthorized");
    }
  });

  it("6. Executes Mindshare dynamic swap and accrues yield to vault stakers", async () => {
    const [agentVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("agent_vault"), Buffer.from(agentId)],
      program.programId
    );
    const [bondingReservePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bonding_reserve"), Buffer.from(agentId)],
      program.programId
    );

    const quoteIn = new anchor.BN(500_000_000); // 500 Quote tokens
    const minSharesOut = new anchor.BN(10_000);

    await program.methods
      .buyShares(quoteIn, minSharesOut)
      .accounts({
        buyer: authority.publicKey,
        globalConfig: globalConfigPda,
        agentVault: agentVaultPda,
        bondingReserve: bondingReservePda,
        buyerQuoteAccount: userQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vault = await program.account.agentVault.fetch(agentVaultPda);
    expect(vault.circulatingShares.toNumber()).to.be.greaterThan(0);
    expect(vault.reserveBalance.toNumber()).to.be.greaterThan(0);
  });
});