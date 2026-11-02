"""
CookieMind Autonomous Mindshare Oracle Keeper
Submits verified mindshare index ticks directly to Solana CookieMind program.
"""

import asyncio
import os
import hashlib
import aiohttp
from typing import Optional
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.instruction import Instruction, AccountMeta
from solders.transaction import VersionedTransaction
from solders.message import MessageV0
import struct

PROGRAM_ID = Pubkey.from_string("Cook1eM1nd111111111111111111111111111111111")
COOKIE_API_URL = os.getenv("COOKIE_API_URL", "https://api.cookie.fun/v1/hackathon/mindshare")
ORACLE_SECRET = os.getenv("ORACLE_KEYPAIR_RAW", "[1,2,3...]") # Keypair bytes

def get_discriminator(namespace: str, name: str) -> bytes:
    val = f"{namespace}:{name}".encode("utf-8")
    return hashlib.sha256(val).digest()[:8]

class CookieOracleKeeper:
    def __init__(self, rpc_endpoint: str, oracle_keypair: Keypair):
        self.client = AsyncClient(rpc_endpoint)
        self.oracle = oracle_keypair
        self.update_discriminator = get_discriminator("global", "update_mindshare")

    async def fetch_mindshare_metrics(self, agent_id_hex: str) -> Optional[dict]:
        async with aiohttp.ClientSession() as session:
            headers = {"Authorization": f"Bearer {os.getenv('COOKIE_API_KEY', 'default_test')}"}
            async with session.get(f"{COOKIE_API_URL}/{agent_id_hex}", headers=headers) as resp:
                if resp.status == 200:
                    return await resp.json()
                return None

    async def dispatch_update(self, agent_id_bytes: bytes, mindshare_bps: int, reward_delta: int):
        # Derive PDAs
        config_pda, _ = Pubkey.find_program_address([b"config"], PROGRAM_ID)
        agent_pda, _ = Pubkey.find_program_address([b"agent", agent_id_bytes], PROGRAM_ID)

        # Build instruction data
        # Discriminator (8 bytes) + u32 (4 bytes) + u64 (8 bytes)
        ix_data = (
            self.update_discriminator
            + struct.pack("<I", mindshare_bps)
            + struct.pack("<Q", reward_delta)
        )

        accounts = [
            AccountMeta(pubkey=self.oracle.pubkey(), is_signer=True, is_writable=False),
            AccountMeta(pubkey=config_pda, is_signer=False, is_writable=False),
            AccountMeta(pubkey=agent_pda, is_signer=False, is_writable=True),
        ]

        ix = Instruction(PROGRAM_ID, ix_data, accounts)
        
        latest_blockhash_resp = await self.client.get_latest_blockhash()
        blockhash = latest_blockhash_resp.value.blockhash

        msg = MessageV0.try_compile(
            payer=self.oracle.pubkey(),
            instructions=[ix],
            address_lookup_table_accounts=[],
            recent_blockhash=blockhash
        )
        tx = VersionedTransaction(msg, [self.oracle])
        
        send_resp = await self.client.send_transaction(tx)
        print(f"[CookieKeeper] Dispatched Mindshare Tick | Sig: {send_resp.value}")

    async def run_loop(self, agent_slug: str):
        agent_id_bytes = hashlib.sha256(agent_slug.encode()).digest()
        while True:
            try:
                data = await self.fetch_mindshare_metrics(agent_slug)
                if data:
                    bps = int(data.get("mindshare_ratio", 0.05) * 10000)
                    reward_inject = int(data.get("reward_delta", 1_000_000))
                    await self.dispatch_update(agent_id_bytes, bps, reward_inject)
            except Exception as e:
                print(f"[CookieKeeper Error] Tick failed: {str(e)}")
            await asyncio.sleep(10) # 10s keeper epoch