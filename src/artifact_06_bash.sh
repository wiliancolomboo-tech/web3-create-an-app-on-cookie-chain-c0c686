# 1. Build the Anchor program to generate keypairs and IDL
anchor build

# 2. Fetch the newly generated Program ID
solana address -k target/deploy/cookie_jar-keypair.json

# 3. Synchronize keys across lib.rs and Anchor.toml
anchor keys sync