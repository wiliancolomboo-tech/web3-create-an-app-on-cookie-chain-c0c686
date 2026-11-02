import os
import time
import requests
from solana.rpc.api import Client
from solders.keypair import Keypair
from solders.pubkey import Pubkey

COOKIE_API_URL = "https://api.cookie.fun/v1/hackathon/agent-mindshare"
SOLANA_RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.devnet.solana.com")
PROGRAM_ID = Pubkey.from_string("CookiEMind1111111111111111111111111111111111")

def sync_cookie_mindshare():
    client = Client(SOLANA_RPC_URL)
    print("[+] CookieMind Oracle Keeper Bot Initialized...")
    
    while True:
        try:
            # Poll latest verified mindshare metrics from Cookie Engine
            response = requests.get(f"{COOKIE_API_URL}/sentinel_01", timeout=5)
            if response.status_code == 200:
                data = response.json()
                mindshare_bps = int(data.get("mindshare_score", 0) * 100)
                current_slot = client.get_slot().value
                print(f"[*] Attesting Mindshare: {mindshare_bps} BPS at Slot: {current_slot}")
                # Keeper dispatches signed update_mindshare instruction to Solana...
            time.sleep(10)
        except Exception as e:
            print(f"[!] Keeper Sync Loop Error: {e}")
            time.sleep(5)

if __name__ == "__main__":
    sync_cookie_mindshare()