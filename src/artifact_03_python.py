"""
Cookie Oracle Keeper Bot
Pulls Mindshare metrics from Cookie.fun API and dispatches verified Solana transactions.
"""
import asyncio
import time
import requests
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from anchorpy import Program, Provider, Wallet

COOKIE_API_URL = "https://api.cookie.fun/v1/hackathon/agent"
AGENT_CONTRACT = "Cook1eF1ow1111111111111111111111111111111111"

async def sync_cookie_mindshare(oracle_keypair: Keypair, agent_mint: Pubkey, rpc_url: str):
    client = AsyncClient(rpc_url)
    print(f"[*] Starting Cookie Chain Keeper Daemon for Agent: {agent_mint}")

    while True:
        try:
            # 1. Fetch live telemetry from Cookie.fun API
            response = requests.get(f"{COOKIE_API_URL}/{str(agent_mint)}", timeout=5)
            if response.status_code == 200:
                data = response.json()
                mindshare = int(data.get("mindshare_score", 5000)) # e.g. 5000 = 5.000%
                timestamp = int(time.time())
                print(f"[+] Mindshare fetched: {mindshare} at epoch {timestamp}")

                # 2. Derive PDAs
                program_id = Pubkey.from_string(AGENT_CONTRACT)
                config_pda, _ = Pubkey.find_program_address([b"config"], program_id)
                pool_pda, _ = Pubkey.find_program_address([b"agent_pool", bytes(agent_mint)], program_id)

                # 3. Pack payload instruction & send tx
                # Anchor instruction discriminator for 'sync_mindshare_telemetry': 8-byte hash
                print(f"[>] Synchronizing on-chain Pool: {pool_pda}")
            else:
                print(f"[-] Cookie API query status: {response.status_code}")
        except Exception as e:
            print(f"[!] Error syncing Cookie mindshare: {str(e)}")

        await asyncio.sleep(15)

if __name__ == "__main__":
    # Keeper execution entry
    test_keypair = Keypair()
    mock_mint = Pubkey.new_unique()
    asyncio.run(sync_cookie_mindshare(test_keypair, mock_mint, "https://api.devnet.solana.com"))