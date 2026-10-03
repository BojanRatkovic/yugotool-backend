ALTER TABLE "projects" ALTER COLUMN "local_only" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "repos_root" text;