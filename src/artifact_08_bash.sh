# 1. Set network to devnet
solana config set --url devnet

# 2. Fund deployment keypair
solana airdrop 2

# 3. Deploy to Solana Devnet
anchor deploy --provider.cluster devnet

# 4. Run verification tests against Devnet deployment
ANCHOR_PROVIDER_URL="https://api.devnet.solana.com" anchor test --skip-deploy