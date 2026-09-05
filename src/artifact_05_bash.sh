# 1. Initialize anchor project
anchor init cookie-jar --template multiple
cd cookie-jar

# 2. Add dependencies to Cargo.toml
cat << 'EOF' > programs/cookie-jar/Cargo.toml
[package]
name = "cookie-jar"
version = "0.1.0"
description = "Cookie Jar Autonomous Mindshare Escrow"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "cookie_jar"

[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []

[dependencies]
anchor-lang = { version = "0.30.1", features = ["init-if-needed"] }
anchor-spl = { version = "0.30.1" }
EOF

# 3. Add TypeScript dependencies
yarn add @coral-xyz/anchor @solana/spl-token @solana/web3.js chai mocha @types/chai @types/mocha ts-mocha typescript