# 1. Clone & Navigate
git clone https://github.com/example/cookiestream-protocol.git
cd cookiestream-protocol

# 2. Build Anchor Program
anchor build

# 3. Synchronize Program ID (if different from declare_id!)
anchor keys sync

# 4. Verify Localnet Configuration in Anchor.toml
cat << 'EOF' > Anchor.toml
[toolchain]
[features]
resolution = true
skip-lint = false

[programs.localnet]
cookiestream = "CookiE1111111111111111111111111111111111111"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "Localnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
EOF

# 5. Run Complete Integration Suite
anchor test