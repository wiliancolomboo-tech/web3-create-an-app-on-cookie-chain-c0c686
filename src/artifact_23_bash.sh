# Configure Solana CLI to Devnet
solana config set --url https://api.devnet.solana.com

# Fund Deployer Keypair
solana airdrop 2

# Deploy program binary to Devnet
anchor deploy --provider.cluster devnet

# Verify program account
solana program show CookiE9vN3GvPz5xM7YcKkU7gEw1f4dHs4N3sV1Q7777