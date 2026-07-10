CREATE TABLE "landing_analytics_dedupe" (
	"surface" varchar(32) NOT NULL,
	"dedupe_key" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "landing_analytics_dedupe_pk" PRIMARY KEY("surface","dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "landing_analytics_global_quota" (
	"surface" varchar(32) NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"event_count" integer NOT NULL,
	CONSTRAINT "landing_analytics_global_quota_pk" PRIMARY KEY("surface","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "landing_analytics_visitor_quota" (
	"surface" varchar(32) NOT NULL,
	"visitor_hash" varchar(64) NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"event_count" integer NOT NULL,
	CONSTRAINT "landing_analytics_visitor_quota_pk" PRIMARY KEY("surface","visitor_hash","bucket_start")
);
--> statement-breakpoint
ALTER TABLE "landing_download" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "landing_download" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "landing_page_view" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "landing_page_view" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
CREATE INDEX "landing_analytics_dedupe_expires_at_idx" ON "landing_analytics_dedupe" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "landing_analytics_global_quota_bucket_start_idx" ON "landing_analytics_global_quota" USING btree ("bucket_start");--> statement-breakpoint
CREATE INDEX "landing_analytics_visitor_quota_bucket_start_idx" ON "landing_analytics_visitor_quota" USING btree ("bucket_start");
