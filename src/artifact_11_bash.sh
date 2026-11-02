# Fund your deployer wallet on Devnet
solana airdrop 2 -u devnet

# Update Anchor.toml cluster to devnet
# [provider]
# cluster = "devnet"

# Deploy to Devnet
anchor deploy --provider.cluster devnet

# Verify Program Deployment
solana program show CookiE1111111111111111111111111111111111111 -u devnet