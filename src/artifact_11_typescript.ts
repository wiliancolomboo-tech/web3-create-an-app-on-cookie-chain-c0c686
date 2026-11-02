// scripts/interact.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieSwarm } from "../target/types/cookie_swarm";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CookieSwarm as Program<CookieSwarm>;

  const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const config = await program.account.globalConfig.fetch(configPda);
  console.log("CookieSwarm Config Authority:", config.authority.toBase58());
  console.log("Verified Oracle Signer:", config.oracleSigner.toBase58());
  console.log("Total Registered Agents:", config.totalAgents.toString());
}

main().catch(console.error);