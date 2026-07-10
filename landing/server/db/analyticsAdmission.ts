import { sql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';

export type TLandingAnalyticsSurface = 'download' | 'page_view';

interface ILandingAnalyticsAdmissionInput {
    bucketSeconds: number;
    city: string | null;
    country: string | null;
    dedupeKey: string;
    dedupeSeconds: number;
    event: Record<string, unknown>;
    globalEventLimit: number;
    region: string | null;
    surface: TLandingAnalyticsSurface;
    userAgent: string | null;
    visitorEventLimit: number;
    visitorHash: string;
}

export async function admitLandingAnalyticsEvent(
    db: NeonHttpDatabase,
    input: ILandingAnalyticsAdmissionInput,
) {
    await db.execute(sql`
        select public.admit_landing_analytics_event(
            ${input.surface},
            cast(${JSON.stringify(input.event)} as jsonb),
            ${input.visitorHash},
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
