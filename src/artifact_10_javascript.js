// Quick sanity check inside Anchor console
const program = anchor.workspace.CookiePulse;
const [config] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("cookie_pulse_config")], program.programId);
console.log("CookiePulse Global Config Address:", config.toBase58());