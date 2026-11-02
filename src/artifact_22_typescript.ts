const program = anchor.workspace.CookieChainApp;
const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("global-config")],
  program.programId
);

await program.methods
  .initialize(200, provider.wallet.publicKey) // 2% protocol fee
  .accounts({
    config: configPda,
    admin: provider.wallet.publicKey,
    systemProgram: anchor.web3.SystemProgram.programId,
  })
  .rpc();

console.log("CookieAgentFi deployed and initialized successfully at:", configPda.toBase58());