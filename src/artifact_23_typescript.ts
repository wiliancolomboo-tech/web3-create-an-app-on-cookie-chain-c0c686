import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieStream } from "../target/types/cookie_stream";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CookieStream as Program<CookieStream>;

  console.log("Interacting with CookieStream on:", provider.connection.rpcEndpoint);
  console.log("Program ID:", program.programId.toBase58());
  
  // Script executes standard lifecycle interactions against live Devnet accounts...
}

main().catch(console.error);