-- The sessions that were kept for site accounts are dropped, once.
--
-- With 1.8.0-rc.5 a project could name two accounts of one site. Its run had
-- one browser for both, and what the sign-in of the one left was kept as the
-- session of the other too: an account could be let in as another one. A
-- project names one account of a site from here on, and nothing says which
-- of the sessions kept so far are another account's. So each account signs
-- in anew, and keeps its own.
UPDATE `site_accounts` SET `session_ciphertext` = NULL, `session_saved_at` = NULL, `session_cookies` = 0 WHERE `session_ciphertext` IS NOT NULL;
