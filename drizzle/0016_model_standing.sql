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
ALTER TABLE `projects` ADD `stand_ins` integer;--> statement-breakpoint
-- A model that is marked for audio and not for text writes down what is said:
-- it cannot answer a chat request, and from this version the check does not
-- ask it one. What the check wrote on such a model until now (it failed, each
-- time) says nothing about it, and would keep it out of the lists for good.
UPDATE `models` SET `last_test_status` = NULL, `last_test_error` = NULL, `last_tested_at` = NULL, `check_failures` = 0
WHERE `id` IN (SELECT `model_row_id` FROM `model_capabilities` WHERE `capability` = 'audio')
  AND `id` NOT IN (SELECT `model_row_id` FROM `model_capabilities` WHERE `capability` = 'text');
