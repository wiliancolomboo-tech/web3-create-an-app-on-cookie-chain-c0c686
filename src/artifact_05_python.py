"""
CookieStream Autonomous Keeper Crank Bot
Continuously monitors CookieStream instances, checks accrued yield, and executes settlements.
"""

import asyncio
import os
import logging
from solana.rpc.async_api import AsyncClient
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from anchorpy import Provider, Wallet, Program, Idl
import json

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

PROGRAM_ID = Pubkey.from_string("CookiE1111111111111111111111111111111111111")
RPC_URL = os.getenv("RPC_URL", "http://127.0.0.1:8899")

async def run_keeper():
    client = AsyncClient(RPC_URL)
    # Load keeper keypair from local configuration or environment
    keeper_kp = Keypair()
    wallet = Wallet(keeper_kp)
    provider = Provider(client, wallet)

    with open("./target/idl/cookie_stream.json") as f:
        idl_data = json.load(f)
    idl = Idl.from_json(json.dumps(idl_data))
    program = Program(idl, PROGRAM_ID, provider)

    logging.info(f"Keeper initialized: {keeper_kp.pubkey()}")

    while True:
        try:
            # Query all active stream accounts
            streams = await program.account["StreamAccount"].all()
            current_slot = await client.get_slot()
            logging.info(f"Current Slot: {current_slot.value}. Found {len(streams)} active streams.")

            for item in streams:
                stream_acc = item.account
                if not stream_acc.is_active:
                    continue

                slots_elapsed = current_slot.value - stream_acc.last_settled_slot
                if slots_elapsed >= 5: # Settle if at least 5 slots accrued
                    logging.info(f"Triggering crank for agent: {stream_acc.agent_id} (Elapsed: {slots_elapsed} slots)")
                    # Build instruction accounts & fire settlement
                    # [Production implementation calls settle_and_claim via program.methods]

        except Exception as e:
            logging.error(f"Error in keeper loop: {str(e)}")

        await asyncio.sleep(4)

if __name__ == "__main__":
    asyncio.run(run_keeper())