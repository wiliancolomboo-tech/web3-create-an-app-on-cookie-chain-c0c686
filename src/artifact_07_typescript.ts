// Initialize Market via Script
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
// Call initialize_market with chosen agent metadata
const tx = await program.methods
  .initializeMarket("Cookie Sentinel", "CSENT", "https://api.cookie.fun/csent")
  .accounts({ ...accounts })
  .rpc();
console.log("Market initialized with transaction signature:", tx);