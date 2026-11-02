import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CookieStream;

  console.log("Configuring CookieStream client on cluster:", provider.connection.rpcEndpoint);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("cookie_config")], program.programId);
  
  const config = await program.account.globalConfig.fetch(configPda);
  console.log("CookieStream Admin:", config.admin.toBase58());
  console.log("Oracle Authority:", config.oracleAuthority.toBase58());
  console.log("Protocol Fee BPS:", config.protocolFeeBps);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});