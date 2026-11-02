let drift = (clock.unix_timestamp - timestamp).abs();
   require!(drift <= 300, CookieError::AttestationStale);