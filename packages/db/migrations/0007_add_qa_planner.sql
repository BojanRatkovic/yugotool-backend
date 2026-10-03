ALTER TABLE "projects" ADD COLUMN "local_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "route_map" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "route_discovery" jsonb;--> statement-breakpoint
ALTER TABLE "qa_checks" ADD COLUMN "reason" text;