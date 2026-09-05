# Step 1: Start test validator in a separate background terminal
solana-test-validator --reset

# Step 2: Configure CLI to target localnet
solana config set --url localhost

# Step 3: Deploy compiled binary
solana program deploy target/deploy/cookie_jar.so

# Step 4: Verify deployed program status
solana program show Cook1eJar11111111111111111111111111111111111