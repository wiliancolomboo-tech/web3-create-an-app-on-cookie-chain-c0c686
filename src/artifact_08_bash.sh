# 1. Configure RPC for Cookie Chain testnet
solana config set --url https://rpc.cookiechain-testnet.cookie3.co

# 2. Fund deployment wallet
solana airdrop 2

# 3. Deploy the compiled program binary
anchor deploy --program-name cookie_jar --provider.cluster https://rpc.cookiechain-testnet.cookie3.co

# 4. Verify deployment
solana program show $(solana address -k target/deploy/cookie_jar-keypair.json)