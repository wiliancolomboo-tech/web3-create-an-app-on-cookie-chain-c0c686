let min_rent = Rent::get()?.minimum_balance(0);
   let available_funds = current_lamports.saturating_sub(min_rent);
   require!(amount <= available_funds, CookiePulseError::InsufficientComputeFunds);