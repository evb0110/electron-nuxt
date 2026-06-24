import { sql } from 'drizzle-orm';
import {
    index,
    jsonb,
    pgTable,
    serial,
    text,
    timestamp,
    varchar,
} from 'drizzle-orm/pg-core';
import type { JsonObject } from 'type-fest';
import { ANALYTICS_GEO_LIMITS } from '@contracts/analytics';

export const viewerAnalyticsEvent = pgTable(
    'viewer_analytics_event',
    {
        id: serial('id').primaryKey(),
        eventName: varchar('event_name', { length: 80 }).notNull(),
        path: varchar('path', { length: 255 }),
        locale: varchar('locale', { length: 16 }),
        screenCategory: varchar('screen_category', { length: 16 }),
        sessionId: varchar('session_id', { length: 64 }),
        referrer: text('referrer'),
        country: varchar('country', { length: ANALYTICS_GEO_LIMITS.country }),
        city: varchar('city', { length: ANALYTICS_GEO_LIMITS.city }),
        region: varchar('region', { length: ANALYTICS_GEO_LIMITS.region }),
        visitorHash: varchar('visitor_hash', { length: 64 }),
        deploymentHost: varchar('deployment_host', { length: 255 }),
        userAgent: text('user_agent'),
        payload: jsonb('payload').$type<JsonObject>().notNull().default(sql`'{}'::jsonb`),
        occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    table => [
        index('viewer_analytics_event_name_occurred_at_idx').on(table.eventName, table.occurredAt),
        index('viewer_analytics_event_occurred_at_idx').on(table.occurredAt),
        index('viewer_analytics_event_path_idx').on(table.path),
        index('viewer_analytics_event_session_id_idx').on(table.sessionId),
        index('viewer_analytics_event_visitor_hash_idx').on(table.visitorHash),
    ],
);
