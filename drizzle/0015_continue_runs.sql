-- A run can go on with the tasks of the run before it (1.9.0): the tasks that
-- had succeeded are kept, the others are done again. `continued` marks such a
-- run, and `tokens_before` is what the tasks it kept had used, so that the
-- run's own count is what it used itself.
ALTER TABLE `project_runs` ADD `continued` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `project_runs` ADD `tokens_before` integer DEFAULT 0 NOT NULL;
