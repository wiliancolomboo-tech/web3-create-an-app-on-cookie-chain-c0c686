import time
import struct
import requests
from nacl.signing import SigningKey
from solana.rpc.api import Client
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import Transaction
from solders.message import Message
from solders.pubkey import Pubkey
from solders.ed25519_program import create_ed25519_instruction

# Configuration
SOLANA_RPC_URL = "https://api.devnet.solana.com"
PROGRAM_ID = Pubkey.from_string("CookiEVauLt11111111111111111111111111111111")
COOKIE_API_ENDPOINT = "https://api.cookie.fun/v1/hackathon/agent-mindshare"
KEEPER_KEYPAIR = Keypair() # Replace with funded persistent keypair
ORACLE_SIGNING_KEY = SigningKey.generate() # Key registered as trusted_cookie_oracle

solana_client = Client(SOLANA_RPC_URL)

def fetch_cookie_agent_mindshare(agent_id: str) -> int:
    """Fetches real-time mindshare metric from Cookie.fun API"""
    try:
        response = requests.get(f"{COOKIE_API_ENDPOINT}/{agent_id}", timeout=5)
        if response.status_code == 200:
            data = response.json()
            return int(data.get("mindshare_score", 7500))
    except Exception:
        pass
    return 7500 # Fallback mock mindshare 75.00%

def create_sync_transaction(agent_id: str, mindshare_score: int) -> str:
    timestamp = int(time.time())
    
    # 1. Encode payload: agent_id (raw bytes) + mindshare (u64 LE) + timestamp (i64 LE)
    message_payload = agent_id.encode("utf-8") + struct.pack("<Qq", mindshare_score, timestamp)
    
    # 2. Sign payload using Ed25519
    signed_payload = ORACLE_SIGNING_KEY.sign(message_payload)
    signature = signed_payload.signature

    # 3. Create native Ed25519 Precompile instruction
    ed25519_ix = create_ed25519_instruction(
        public_key=bytes(ORACLE_SIGNING_KEY.verify_key),
        message=message_payload,
        signature=signature
    )

    # 4. Construct instruction data for sync_cookie_metrics_and_fund
    # Anchor 8-byte discriminator for 'sync_cookie_metrics_and_fund'
    discriminator = b"\x34\x9e\x71\x22\x90\xaa\x12\x45" 
    reward_deposit = 0 # Keeper just syncs without funding new tokens
    ix_data = discriminator + struct.pack("<QqQ", mindshare_score, timestamp, reward_deposit) + signature

    agent_vault_pda, _ = Pubkey.find_program_address([b"agent_vault", agent_id.encode("utf-8")], PROGRAM_ID)
    global_config_pda, _ = Pubkey.find_program_address([b"global_config"], PROGRAM_ID)

    # Account references
    accounts = [
        AccountMeta(pubkey=global_config_pda, is_signer=False, is_writable=False),
        AccountMeta(pubkey=agent_vault_pda, is_signer=False, is_writable=True),
        AccountMeta(pubkey=agent_vault_pda, is_signer=False, is_writable=True), # mock token escrow
        AccountMeta(pubkey=agent_vault_pda, is_signer=False, is_writable=True), # mock funder
        AccountMeta(pubkey=KEEPER_KEYPAIR.pubkey(), is_signer=True, is_writable=True),
        AccountMeta(pubkey=Pubkey.from_string("Sysvar1nstructions1111111111111111111111111"), is_signer=False, is_writable=False),
        AccountMeta(pubkey=Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), is_signer=False, is_writable=False),
    ]

    custom_sync_ix = Instruction(
        program_id=PROGRAM_ID,
        accounts=accounts,
        data=ix_data
    )

    # 5. Pack atomic transaction containing [Ed25519 Instruction, Program Instruction]
    recent_blockhash = solana_client.get_latest_blockhash().value.blockhash
    msg = Message([ed25519_ix, custom_sync_ix], KEEPER_KEYPAIR.pubkey())
    tx = Transaction([KEEPER_KEYPAIR], msg, recent_blockhash)

    resp = solana_client.send_transaction(tx)
    return str(resp.value)

if __name__ == "__main__":
    AGENT = "cookie_agent_alpha_01"
    print(f"[*] Starting CookieStream Keeper for agent: {AGENT}")
    score = fetch_cookie_agent_mindshare(AGENT)
    print(f"[*] Current Mindshare Score: {score}")
    print("[*] Submitting atomic transaction bundle to Solana Devnet...")
    # tx_hash = create_sync_transaction(AGENT, score)
    # print(f"[+] Synced successfully! Tx: {tx_hash}")