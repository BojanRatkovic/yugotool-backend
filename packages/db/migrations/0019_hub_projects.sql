ALTER TABLE "projects" ADD COLUMN "kind" text DEFAULT 'repo' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_settings" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "repo" text;--> statement-breakpoint
ALTER TABLE "station_runs" ADD COLUMN "research" jsonb;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "repo" text;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "follows_id" uuid;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_follows_id_work_orders_id_fk" FOREIGN KEY ("follows_id") REFERENCES "public"."work_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_orders_follows_id_idx" ON "work_orders" USING btree ("follows_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_kind_check" CHECK ("projects"."kind" in ('repo', 'hub'));