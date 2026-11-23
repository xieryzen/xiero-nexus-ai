-- What real work says about a model (1.10.0). `use_failures`: requests that
-- failed in a row because of the provider; three put the model away as a
-- failed check does. `retry_at`: the model said "not now", and is neither
-- chosen by the app nor asked by the check before this time.
ALTER TABLE `models` ADD `use_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `retry_at` integer;