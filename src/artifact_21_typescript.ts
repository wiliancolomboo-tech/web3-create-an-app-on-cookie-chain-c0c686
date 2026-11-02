import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieMind } from "../target/types/cookie_mind";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CookieMind as Program<CookieMind>;

  console.log("CookieMind Program Address:", program.programId.toBase58());

  const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("cookie_config")],
    program.programId
  );
  console.log("Global Config PDA:", configPda.toBase58());

  console.log("Protocol initialized successfully on target cluster.");
}

main().catch(console.error);