import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieChain } from "../target/types/cookie_chain";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { expect } from "chai";
import * as nacl from "tweetnacl";

describe("cookie-chain test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieChain as Program<CookieChain>;

  const admin = Keypair.generate();
  const oracleKeypair = Keypair.generate();
  const creator = Keypair.generate();
  const buyer = Keypair.generate();
  const agentId = "eliza_cookie_001";

  let globalConfigPda: PublicKey;
  let agentRegistryPda: PublicKey;
  let vaultReservePda: PublicKey;
  let userPositionPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const kp of [admin, creator, buyer]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_config")],
      program.programId
    );

    [agentRegistryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent_registry"), Buffer.from(agentId)],
      program.programId
    );

    [vaultReservePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_reserve"), Buffer.from(agentId)],
      program.programId
    );

    [userPositionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_position"),
        agentRegistryPda.toBuffer(),
        buyer.publicKey.toBuffer(),
      ],
      program.programId
    );
  });

  it("1. Initializes Protocol successfully", async () => {
    const feeBps = 300; // 3%
    await program.methods
      .initializeProtocol(feeBps, oracleKeypair.publicKey)
      .accounts({
        globalConfig: globalConfigPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const config = await program.account.globalConfig.fetch(globalConfigPda);
    expect(config.feeBps).to.equal(300);
    expect(config.oracleSigner.toBase58()).to.equal(
      oracleKeypair.publicKey.toBase58()
    );
    expect(config.totalAgents.toNumber()).to.equal(0);
  });

  it("2. Registers an AI Agent with Cookie Mindshare", async () => {
    const initialMindshare = new anchor.BN(8500); // 85.00 mindshare

    await program.methods
      .registerAgent(agentId, initialMindshare)
      .accounts({
        globalConfig: globalConfigPda,
        agentRegistry: agentRegistryPda,
        vaultReserve: vaultReservePda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const registry = await program.account.agentRegistry.fetch(agentRegistryPda);
    expect(registry.agentId).to.equal(agentId);
    expect(registry.mindshareScore.toNumber()).to.equal(8500);
    expect(registry.creator.toBase58()).to.equal(creator.publicKey.toBase58());
  });

  it("3. Updates Mindshare using Ed25519 Instruction Introspection", async () => {
    const newMindshare = new anchor.BN(9200);
    const now = Math.floor(Date.now() / 1000);
    const timestampBn = new anchor.BN(now);

    // Encode message payload: [new_mindshare: u64 LE, timestamp: i64 LE]
    const msgBuffer = Buffer.alloc(16);
    msgBuffer.writeBigUInt64LE(BigInt(newMindshare.toString()), 0);
    msgBuffer.writeBigInt64LE(BigInt(now), 8);

    const signature = nacl.sign.detached(msgBuffer, oracleKeypair.secretKey);

    // Build Native Ed25519 instruction
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: oracleKeypair.publicKey.toBytes(),
      message: msgBuffer,
      signature: signature,
    });

    const updateIx = await program.methods
      .updateMindshare(newMindshare, timestampBn)
      .accounts({
        globalConfig: globalConfigPda,
        agentRegistry: agentRegistryPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(ed25519Ix).add(updateIx);
    await provider.sendAndConfirm(tx, []);

    const registry = await program.account.agentRegistry.fetch(agentRegistryPda);
    expect(registry.mindshareScore.toNumber()).to.equal(9200);
    expect(registry.lastUpdateTs.toNumber()).to.equal(now);
  });

  it("4. Buys AI Agent shares along the dynamic curve", async () => {
    const depositSol = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const minSharesExpected = new anchor.BN(1);

    const creatorBalBefore = await provider.connection.getBalance(creator.publicKey);
    const adminBalBefore = await provider.connection.getBalance(admin.publicKey);

    await program.methods
      .buyAgentShares(depositSol, minSharesExpected)
      .accounts({
        globalConfig: globalConfigPda,
        agentRegistry: agentRegistryPda,
        vaultReserve: vaultReservePda,
        userPosition: userPositionPda,
        creator: creator.publicKey,
        protocolTreasury: admin.publicKey,
        buyer: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const position = await program.account.userPosition.fetch(userPositionPda);
    expect(position.sharesHeld.toNumber()).to.be.greaterThan(0);

    const registry = await program.account.agentRegistry.fetch(agentRegistryPda);
    expect(registry.reserveLamports.toNumber()).to.be.greaterThan(0);

    // Check fee collection (3% total: 1.5% to creator, 1.5% to DAO admin)
    const creatorBalAfter = await provider.connection.getBalance(creator.publicKey);
    const adminBalAfter = await provider.connection.getBalance(admin.publicKey);
    expect(creatorBalAfter).to.be.greaterThan(creatorBalBefore);
    expect(adminBalAfter).to.be.greaterThan(adminBalBefore);
  });

  it("5. Sells a portion of Agent shares with Slippage Protection", async () => {
    const positionBefore = await program.account.userPosition.fetch(userPositionPda);
    const sellAmount = positionBefore.sharesHeld.div(new anchor.BN(2));
    const minLamportsReturn = new anchor.BN(100_000); // 0.0001 SOL min

    await program.methods
      .sellAgentShares(sellAmount, minLamportsReturn)
      .accounts({
        globalConfig: globalConfigPda,
        agentRegistry: agentRegistryPda,
        vaultReserve: vaultReservePda,
        userPosition: userPositionPda,
        protocolTreasury: admin.publicKey,
        seller: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc();

    const positionAfter = await program.account.userPosition.fetch(userPositionPda);
    expect(positionAfter.sharesHeld.toNumber()).to.equal(
      positionBefore.sharesHeld.sub(sellAmount).toNumber()
    );
  });

  it("6. Rejects forged oracle updates (Security Negative Test)", async () => {
    const maliciousKeypair = Keypair.generate();
    const fakeMindshare = new anchor.BN(99999);
    const now = Math.floor(Date.now() / 1000);
    const timestampBn = new anchor.BN(now);

    const msgBuffer = Buffer.alloc(16);
    msgBuffer.writeBigUInt64LE(BigInt(fakeMindshare.toString()), 0);
    msgBuffer.writeBigInt64LE(BigInt(now), 8);

    const fakeSignature = nacl.sign.detached(msgBuffer, maliciousKeypair.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: maliciousKeypair.publicKey.toBytes(),
      message: msgBuffer,
      signature: fakeSignature,
    });

    const updateIx = await program.methods
      .updateMindshare(fakeMindshare, timestampBn)
      .accounts({
        globalConfig: globalConfigPda,
        agentRegistry: agentRegistryPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new anchor.web3.Transaction().add(ed25519Ix).add(updateIx);

    try {
      await provider.sendAndConfirm(tx, []);
      expect.fail("Transaction should have failed authorization check");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedOracleSigner");
    }
  });
});