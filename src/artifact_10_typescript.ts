import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieStream } from "../target/types/cookie_stream";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Ed25519Program,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
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

describe("CookieStream Protocol QA Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CookieStream as Program<CookieStream>;

  const admin = Keypair.generate();
  const oracleAuthority = Keypair.generate();
  const sponsor = Keypair.generate();
  const agentBeneficiary = Keypair.generate();

  let mint: PublicKey;
  let sponsorTokenAccount: PublicKey;
  let beneficiaryTokenAccount: PublicKey;
  let configPda: PublicKey;
  let streamPda: PublicKey;
  let vaultPda: PublicKey;

  const streamId = new anchor.BN(4242);
  const baseRate = new anchor.BN(10_000); // 10k tokens / second
  const multiplierBps = new anchor.BN(5_000); // 50% bonus factor
  const initialFunding = new anchor.BN(10_000_000_000); // 10,000 tokens

  before(async () => {
    // Fund Test Wallets
    for (const kp of [admin, sponsor, agentBeneficiary]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Deploy test SPL token
    mint = await createMint(provider.connection, sponsor, sponsor.publicKey, null, 6);
    sponsorTokenAccount = await createAccount(provider.connection, sponsor, mint, sponsor.publicKey);
    beneficiaryTokenAccount = await createAccount(
      provider.connection,
      agentBeneficiary,
      mint,
      agentBeneficiary.publicKey
    );

    await mintTo(provider.connection, sponsor, mint, sponsorTokenAccount, sponsor, 100_000_000_000);

    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    [streamPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("stream"),
        sponsor.publicKey.toBuffer(),
        mint.toBuffer(),
        streamId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), streamPda.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes protocol configuration with Oracle Authority", async () => {
    await program.methods
      .initializeProtocol(oracleAuthority.publicKey)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.oracleAuthority.toBase58()).to.equal(oracleAuthority.publicKey.toBase58());
  });

  it("2. Creates stream and escrows tokens in Vault PDA", async () => {
    await program.methods
      .createStream(streamId, baseRate, multiplierBps, initialFunding)
      .accounts({
        stream: streamPda,
        vault: vaultPda,
        mint: mint,
        sponsorTokenAccount: sponsorTokenAccount,
        beneficiary: agentBeneficiary.publicKey,
        sponsor: sponsor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([sponsor])
      .rpc();

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(initialFunding.toNumber());
  });

  it("3. Ingests Mindshare telemetry using Ed25519 signature introspection", async () => {
    const mindshareScore = new anchor.BN(8500); // 85% mindshare
    const timestamp = new anchor.BN(Math.floor(Date.now() / 1000));

    // Construct telemetry message bytes
    const message = Buffer.concat([
      streamId.toArrayLike(Buffer, "le", 8),
      mindshareScore.toArrayLike(Buffer, "le", 8),
      timestamp.toArrayLike(Buffer, "le", 8),
    ]);

    // Sign with Ed25519 Oracle keypair
    const signature = nacl.sign.detached(message, oracleAuthority.secretKey);

    // Build Ed25519 Precompile Instruction
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: oracleAuthority.publicKey.toBytes(),
      message: message,
      signature: signature,
    });

    const updateIx = await program.methods
      .updateMindshareMetric(mindshareScore, timestamp)
      .accounts({
        config: configPda,
        stream: streamPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        keeper: sponsor.publicKey,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(updateIx);
    await provider.sendAndConfirm(tx, [sponsor]);

    const streamAccount = await program.account.streamState.fetch(streamPda);
    expect(streamAccount.currentMindshareScore.toNumber()).to.equal(8500);
  });

  it("4. Rejects forged metric packet with invalid signature", async () => {
    const maliciousKey = Keypair.generate();
    const mindshareScore = new anchor.BN(9999);
    const timestamp = new anchor.BN(Math.floor(Date.now() / 1000));

    const message = Buffer.concat([
      streamId.toArrayLike(Buffer, "le", 8),
      mindshareScore.toArrayLike(Buffer, "le", 8),
      timestamp.toArrayLike(Buffer, "le", 8),
    ]);

    // Signed by malicious key instead of oracle authority
    const forgedSignature = nacl.sign.detached(message, maliciousKey.secretKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: maliciousKey.publicKey.toBytes(),
      message: message,
      signature: forgedSignature,
    });

    const updateIx = await program.methods
      .updateMindshareMetric(mindshareScore, timestamp)
      .accounts({
        config: configPda,
        stream: streamPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        keeper: sponsor.publicKey,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(updateIx);
    try {
      await provider.sendAndConfirm(tx, [sponsor]);
      expect.fail("Should have failed oracle check");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedOracleSigner");
    }
  });

  it("5. Settles and claims mindshare-indexed yield to beneficiary", async () => {
    // Wait 2 seconds to accrue streaming tokens
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await program.methods
      .claimStream()
      .accounts({
        stream: streamPda,
        vault: vaultPda,
        beneficiaryTokenAccount: beneficiaryTokenAccount,
        beneficiary: agentBeneficiary.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agentBeneficiary])
      .rpc();

    const beneficiaryAccount = await getAccount(provider.connection, beneficiaryTokenAccount);
    expect(Number(beneficiaryAccount.amount)).to.be.greaterThan(0);
  });
});