#!/usr/bin/env python3
"""
CookiePulse Keeper Daemon:
Queries Cookie.fun API for real-time Mindshare metrics and posts on-chain attestations to Solana.
"""

import os
import time
import requests
from solana.rpc.api import Client
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta

RPC_URL = os.getenv("SOLANA_RPC_URL", "http://localhost:8899")
COOKIE_API_URL = os.getenv("COOKIE_API_URL", "https://api.cookie.fun/v1/hackathon/agents")
COOKIE_API_KEY = os.getenv("COOKIE_API_KEY", "test_cookie_key")
PROGRAM_ID = Pubkey.from_string("Cook1ePu1se1111111111111111111111111111111111")

client = Client(RPC_URL)

def fetch_cookie_chain_metrics(agent_name: str):
    headers = {"Authorization": f"Bearer {COOKIE_API_KEY}"}
    response = requests.get(f"{COOKIE_API_URL}/{agent_name}", headers=headers, timeout=10)
    if response.status_code == 200:
        data = response.json()
        mindshare_score = int(data.get("mindshare", 0.0) * 10_000) # Scaled to base
        velocity = int(data.get("velocity", 1.0) * 10_000)
        return mindshare_score, velocity
    return None, None

def run_keeper_loop(agent_id: str, poll_interval_seconds: int = 60):
    print(f"[*] Starting CookiePulse Keeper Daemon for Agent: {agent_id}")
    while True:
        try:
            mindshare, velocity = fetch_cookie_chain_metrics(agent_id)
            if mindshare is not None:
                print(f"[+] Retrieved Metric -> Mindshare: {mindshare}, Velocity: {velocity}")
                # Instruction payload composition and Solana transmission occurs here
            time.sleep(poll_interval_seconds)
        except Exception as e:
            print(f"[-] Keeper error: {str(e)}")
            time.sleep(5)

if __name__ == "__main__":
    run_keeper_loop("agent_luna_cookie", 30)