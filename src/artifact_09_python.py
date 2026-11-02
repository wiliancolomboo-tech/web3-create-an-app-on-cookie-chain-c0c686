import os
import requests
from solana.rpc.api import Client
from solders.keypair import Keypair
from solders.pubkey import Pubkey

COOKIE_API_URL = "https://api.cookie.fun/v1/hackathon/agent"
SOLANA_RPC = os.getenv("SOLANA_RPC_URL", "https://api.devnet.solana.com")
ORACLE_PRIVATE_KEY = os.getenv("ORACLE_KEYPAIR_PATH", "./oracle-keypair.json")

def sync_agent_mindshare(agent_id: str):
    # Fetch verified score from Cookie
    response = requests.get(f"{COOKIE_API_URL}/{agent_id}", timeout=10)
    data = response.json()
    mindshare_bps = int(data["mindshare"] * 10000) # Convert float 0.85 -> 8500 bps
    
    print(f"[*] Attesting Agent: {agent_id} | Mindshare BPS: {mindshare_bps}")
    # Dispatch Anchor instruction via RPC client...

if __name__ == "__main__":
    sync_agent_mindshare("agent_cookie_prime")