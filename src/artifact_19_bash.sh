# Set cluster to Devnet
solana config set --url https://api.devnet.solana.com

# Fund deployer account
solana airdrop 2

# Deploy program
anchor deploy --provider.cluster devnet

# Verify deployment
solana program show $PROGRAM_ID