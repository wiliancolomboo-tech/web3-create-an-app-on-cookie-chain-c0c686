import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CookieMindshareVault } from "../target/types/cookie_mindshare_vault";
import axios from "axios";

async function runKeeperCrank() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CookieMindshareVault as Program<CookieMindshareVault>;

  console.log("Starting Cookie Mindshare Autonomous Crank...");

  // Mock polling Cookie.fun public API endpoint for Agent Metrics
  const agentId = "cookie_ai_eliza";
  const mockApiEndpoint = `https://api.cookie.fun/v1/hackathon/agent/${agentId}`;
  
  // In production: const response = await axios.get(mockApiEndpoint, { headers: { 'x-api-key': process.env.COOKIE_API_KEY } });
  const simulatedFeed = {
    agentId,
    mindshareScore: 9200,
    velocityBps: 320,
  };

  const currentSlot = await provider.connection.getSlot();

  const [agentFeedPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("agent_feed"), Buffer.from(simulatedFeed.agentId)],
    program.programId
  );
  const [protocolStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_state")],
    program.programId
  );

  console.log(`Pushing fresh mindshare metrics for ${agentId} at slot ${currentSlot}...`);

  const tx = await program.methods
    .updateMindshareFeed(
      simulatedFeed.agentId,
      new anchor.BN(simulatedFeed.mindshareScore),
      simulatedFeed.velocityBps,
      new anchor.BN(currentSlot)
    )
    .accounts({
      protocolState: protocolStatePda,
      agentFeed: agentFeedPda,
      oracleSigner: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log(`Mindshare feed updated successfully! Tx Signature: ${tx}`);
}

runKeeperCrank().catch((err) => {
  console.error("Crank execution failure:", err);
  process.exit(1);
});