# 1. Clone repository and navigate to root directory
git clone https://github.com/your-org/cookie-sync.git
cd cookie-sync

# 2. Install TypeScript dependencies
yarn install

# 3. Build the Anchor program binary and generate IDL
anchor build

# 4. Extract generated Program ID (if generating fresh keys)
solana address -k target/deploy/cookie_sync-keypair.json
# Ensure the printed address matches `declare_id!()` in `lib.rs` and Anchor.toml