CREATE TABLE "viewer_analytics_dedupe" (
	"dedupe_key" varchar(64) PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "viewer_analytics_global_quota" (
	"bucket_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"event_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "viewer_analytics_visitor_quota" (
	"visitor_hash" varchar(64) NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"event_count" integer NOT NULL,
	CONSTRAINT "viewer_analytics_visitor_quota_pk" PRIMARY KEY("visitor_hash","bucket_start")
);
--> statement-breakpoint
ALTER TABLE "viewer_analytics_event" ADD COLUMN "client_occurred_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "viewer_analytics_dedupe_expires_at_idx" ON "viewer_analytics_dedupe" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "viewer_analytics_global_quota_bucket_start_idx" ON "viewer_analytics_global_quota" USING btree ("bucket_start");--> statement-breakpoint
CREATE INDEX "viewer_analytics_visitor_quota_bucket_start_idx" ON "viewer_analytics_visitor_quota" USING btree ("bucket_start");