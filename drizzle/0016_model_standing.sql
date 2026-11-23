-- What real work says about a model, and stand-ins (1.10.0).
-- models.use_failures: requests that failed in a row because of the provider;
--   three put the model away as a failed check does.
-- models.retry_at: the model said "not now", and is neither chosen by the app
--   nor asked by the check before this time.
-- projects.stand_ins: whether a run goes on with another model that works
--   when the ones it is set to do not answer; NULL is "as the installation
--   is set".
ALTER TABLE `models` ADD `use_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `models` ADD `retry_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `stand_ins` integer;