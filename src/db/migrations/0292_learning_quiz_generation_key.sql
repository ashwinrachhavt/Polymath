ALTER TABLE "quizzes" ADD COLUMN "generation_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "quizzes_generation_key" ON "quizzes" USING btree ("workspace_id","generation_key");