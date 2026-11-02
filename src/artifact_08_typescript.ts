import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieSyndicate } from "../target/types/cookie_syndicate";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import crypto from "crypto";

describe("CookieSyndicate Protocol Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieSyndicate as Program<CookieSyndicate>;

  const admin = Keypair.generate();
  const oracleKeeper = Keypair.generate();
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  const agentId = Array.from(crypto.createHash("sha256").update("agent_luna_cookie").digest());

  let configPda: PublicKey;
  let agentVaultPda: PublicKey;
  let solVaultPda: PublicKey;
  let user1PositionPda: PublicKey;

  before(async () => {
    // Fund test wallets
    const airdropSigners = [admin, oracleKeeper, user1, user2];
    for (const signer of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(signer.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Derive PDA addresses
    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    [agentVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), Buffer.from(agentId)],
      program.programId
    );
    [solVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(agentId)],
      program.programId
    );
    [user1PositionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), agentVaultPda.toBuffer(), user1.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes global protocol configuration", async () => {
    await program.methods
      .initializeProtocol(oracleKeeper.publicKey, 100) // 100 bps = 1%
      .accounts({
        config: configPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.oracleAuthority.toBase58()).to.equal(oracleKeeper.publicKey.toBase58());
    expect(configAccount.totalAgents.toNumber()).to.equal(0);
  });

  it("2. Registers verified Cookie Chain AI Agent", async () => {
    const initialMindshare = new anchor.BN(25000); // 25.000%
    const baseEmissionRate = new anchor.BN(100_000); // 100k lamports/sec

    await program.methods
      .registerAgent(agentId, initialMindshare, baseEmissionRate)
      .accounts({
        config: configPda,
        agentVault: agentVaultPda,
        solVault: solVaultPda,
        authority: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const agent = await program.account.agentVault.fetch(agentVaultPda);
    expect(agent.mindshareScore.toNumber()).to.equal(25000);
    expect(agent.isActive).to.be.true;
    expect(agent.totalStaked.toNumber()).to.equal(0);
  });

  it("3. User stakes 2 SOL into agent vault", async () => {
    const depositAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);

    await program.methods
      .stakeIntoAgent(depositAmount)
      .accounts({
        agentVault: agentVaultPda,
        userPosition: user1PositionPda,
        solVault: solVaultPda,
        user: user1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    const agent = await program.account.agentVault.fetch(agentVaultPda);
    const position = await program.account.userPosition.fetch(user1PositionPda);

    expect(agent.totalStaked.toNumber()).to.equal(depositAmount.toNumber());
    expect(position.shares.toNumber()).to.equal(depositAmount.toNumber());
  });

  it("4. Rejects Oracle update if non-authorized keeper signs", async () => {
    const maliciousKeeper = Keypair.generate();
    const now = Math.floor(Date.now() / 1000);

    try {
      await program.methods
        .updateMindshareOracle(agentId, new anchor.BN(26000), new anchor.BN(now))
        .accounts({
          config: configPda,
          agentVault: agentVaultPda,
          oracleAuthority: maliciousKeeper.publicKey,
        })
        .signers([maliciousKeeper])
        .rpc();
      expect.fail("Should have thrown error on unauthorized oracle signer.");
    } catch (err: any) {
      expect(err.message).to.contain("InvalidOracleSigner");
    }
  });

  it("5. Rejects mindshare updates that exceed the 15% volatility guard", async () => {
    const now = Math.floor(Date.now() / 1000);
    const excessiveMindshare = new anchor.BN(35000); // 40% jump from 25000

    try {
      await program.methods
        .updateMindshareOracle(agentId, excessiveMindshare, new anchor.BN(now))
        .accounts({
          config: configPda,
          agentVault: agentVaultPda,
          oracleAuthority: oracleKeeper.publicKey,
        })
        .signers([oracleKeeper])
        .rpc();
      expect.fail("Should have failed delta circuit breaker.");
    } catch (err: any) {
      expect(err.message).to.contain("ExcessiveMindshareDelta");
    }
  });

  it("6. Accepts valid mindshare update from Cookie Chain Keeper", async () => {
    const now = Math.floor(Date.now() / 1000);
    const validNewMindshare = new anchor.BN(27500); // +10% update (safe)

    await program.methods
      .updateMindshareOracle(agentId, validNewMindshare, new anchor.BN(now))
      .accounts({
        config: configPda,
        agentVault: agentVaultPda,
        oracleAuthority: oracleKeeper.publicKey,
      })
      .signers([oracleKeeper])
      .rpc();

    const agent = await program.account.agentVault.fetch(agentVaultPda);
    expect(agent.mindshareScore.toNumber()).to.equal(27500);
  });

  it("7. Allows user to unstake principal and accrued yield", async () => {
    // Fund Sol Vault with reward yield reserve (so it can pay rewards)
    const yieldFund = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const sig = await provider.connection.requestAirdrop(solVaultPda, yieldFund.toNumber());
    await provider.connection.confirmTransaction(sig, "confirmed");

    const positionBefore = await program.account.userPosition.fetch(user1PositionPda);
    const burnShares = positionBefore.shares;

    await program.methods
      .unstakeFromAgent(burnShares)
      .accounts({
        agentVault: agentVaultPda,
        userPosition: user1PositionPda,
        solVault: solVaultPda,
        user: user1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([user1])
      .rpc();

    const positionAfter = await program.account.userPosition.fetch(user1PositionPda);
    expect(positionAfter.shares.toNumber()).to.equal(0);
  });
});