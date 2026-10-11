CREATE TABLE "claude_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"config_dir" text,
	"api_key" text,
	"email" text,
	"org_name" text,
	"subscription_type" text,
	"managed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_accounts_kind_check" CHECK ("claude_accounts"."kind" in ('config_dir', 'api_key')),
	CONSTRAINT "claude_accounts_kind_fields_check" CHECK (("claude_accounts"."kind" = 'config_dir' and "claude_accounts"."config_dir" is not null) or ("claude_accounts"."kind" = 'api_key' and "claude_accounts"."api_key" is not null))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "claude_account_id" uuid;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "default_claude_account_id" uuid;--> statement-breakpoint
ALTER TABLE "station_runs" ADD COLUMN "account_label" text;--> statement-breakpoint
CREATE UNIQUE INDEX "claude_accounts_config_dir_key" ON "claude_accounts" USING btree ("config_dir");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_claude_account_id_claude_accounts_id_fk" FOREIGN KEY ("claude_account_id") REFERENCES "public"."claude_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_default_claude_account_id_claude_accounts_id_fk" FOREIGN KEY ("default_claude_account_id") REFERENCES "public"."claude_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_claude_account_id_idx" ON "projects" USING btree ("claude_account_id");