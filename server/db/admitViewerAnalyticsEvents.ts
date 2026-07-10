import { sql } from 'drizzle-orm';
import type { JsonObject } from 'type-fest';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import type {
    TAnalyticsEventName,
    TAnalyticsScreenCategory,
} from '@contracts/analytics';
import type * as schema from '@server/db/viewerAnalyticsEvent';

export interface IViewerAnalyticsAdmissionEvent {
    clientOccurredAt: string | null;
    locale: string | null;
    name: TAnalyticsEventName;
    path: string;
    payload: JsonObject;
    referrer: string | null;
    screenCategory: TAnalyticsScreenCategory;
    sessionId: string;
}

interface IViewerAnalyticsAdmissionInput {
    bucketSeconds: number;
    city: string | null;
    country: string | null;
    dedupeKey: string;
    dedupeSeconds: number;
    deploymentHost: string;
    events: IViewerAnalyticsAdmissionEvent[];
    globalEventLimit: number;
    region: string | null;
    userAgent: string | null;
    visitorEventLimit: number;
    visitorHash: string;
}

export async function admitViewerAnalyticsEvents(
    db: NeonHttpDatabase<typeof schema>,
    input: IViewerAnalyticsAdmissionInput,
) {
    await db.execute(sql`
        select public.admit_viewer_analytics_events(
            cast(${JSON.stringify(input.events)} as jsonb),
            ${input.visitorHash},
            ${input.deploymentHost},
            ${input.userAgent},
            ${input.country},
            ${input.city},
            ${input.region},
            ${input.dedupeKey},
            ${input.dedupeSeconds},
            ${input.visitorEventLimit},
            ${input.globalEventLimit},
            ${input.bucketSeconds}
        )
    `);
}
