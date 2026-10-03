ALTER TABLE "station_runs" ADD COLUMN "cache_read_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "station_runs" ADD COLUMN "context_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "station_runs" ADD COLUMN "context_window" integer;--> statement-breakpoint
ALTER TABLE "station_runs" ADD COLUMN "num_turns" integer DEFAULT 0 NOT NULL;