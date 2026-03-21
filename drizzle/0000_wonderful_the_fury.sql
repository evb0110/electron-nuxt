CREATE TABLE "viewer_analytics_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_name" varchar(80) NOT NULL,
	"path" varchar(255),
	"locale" varchar(16),
	"screen_category" varchar(16),
	"session_id" varchar(64),
	"referrer" text,
	"country" varchar(2),
	"city" varchar(255),
	"region" varchar(32),
	"visitor_hash" varchar(64),
	"deployment_host" varchar(255),
	"user_agent" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "viewer_analytics_event_name_occurred_at_idx" ON "viewer_analytics_event" USING btree ("event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "viewer_analytics_event_occurred_at_idx" ON "viewer_analytics_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "viewer_analytics_event_path_idx" ON "viewer_analytics_event" USING btree ("path");--> statement-breakpoint
CREATE INDEX "viewer_analytics_event_session_id_idx" ON "viewer_analytics_event" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "viewer_analytics_event_visitor_hash_idx" ON "viewer_analytics_event" USING btree ("visitor_hash");