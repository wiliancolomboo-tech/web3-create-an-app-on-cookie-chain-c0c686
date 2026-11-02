use anchor_lang::prelude::*;

#[error_code]
pub enum CookieError {
    #[msg("Identifier exceeds maximum length of 32 bytes.")]
    IdTooLong,
    #[msg("Metadata URI exceeds maximum length of 96 bytes.")]
    UriTooLong,
    #[msg("Basis points fee must be <= 1000 (10%).")]
    InvalidFeeConfiguration,
    #[msg("Oracle signature or signer is unauthorized.")]
    UnauthorizedOracle,
    #[msg("Stale oracle data timestamp or epoch mismatch.")]
    StaleOracleUpdate,
    #[msg("Slippage exceeded: output shares lower than limit.")]
    SlippageExceeded,
    #[msg("Insufficient attention shares available to burn.")]
    InsufficientShares,
    #[msg("Mathematical calculation overflowed safe numerical limits.")]
    MathOverflow,
    #[msg("Insufficient pool liquidity to fulfill swap.")]
    InsufficientPoolLiquidity,
}