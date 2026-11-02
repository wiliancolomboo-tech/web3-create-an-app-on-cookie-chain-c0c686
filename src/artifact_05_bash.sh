# 1. Initialize project directory structure
mkdir -p cookie_jar_protocol && cd cookie_jar_protocol
anchor init cookie_jar --typescript
cd cookie_jar

# 2. Install required dependencies
yarn add @solana/spl-token @coral-xyz/anchor chai mocha
yarn add -D typescript @types/chai @types/mocha