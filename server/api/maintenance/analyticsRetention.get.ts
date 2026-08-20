import {
    createError,
    defineEventHandler,
    getHeader,
    setHeader,
} from 'h3';
import { sql } from 'drizzle-orm';
import {
    ANALYTICS_RETENTION_MAX_BATCHES,
    isAnalyticsRetentionRequestAuthorized,
    parseAnalyticsRetentionCount,
} from '@contracts/analyticsRetention';
import { getAnalyticsDb } from '@server/db';
import { getRuntimeEnv } from '@server/utils/getRuntimeEnv';

export default defineEventHandler(async (event) => {
    setHeader(event, 'cache-control', 'no-store');
    const env = getRuntimeEnv();
    if (!isAnalyticsRetentionRequestAuthorized(
        getHeader(event, 'authorization'),
        env.CRON_SECRET,
    )) {
        throw createError({
            statusCode: 401,
            statusMessage: 'Unauthorized',
        });
    }

    const db = getAnalyticsDb(event);
    let deletedRows = BigInt(0);
    let eventsDeleted = BigInt(0);
    let dedupeDeleted = BigInt(0);
    let visitorQuotaDeleted = BigInt(0);
    let globalQuotaDeleted = BigInt(0);
    let hasMore = true;
    let batches = 0;

    while (hasMore && batches < ANALYTICS_RETENTION_MAX_BATCHES) {
        const purgeResults = await db.batch([
            db.execute(sql`set local lock_timeout = '2s'`),
            db.execute(sql`set local statement_timeout = '4s'`),
            db.execute<{
                dedupeDeleted: string
                deletedRows: string
                eventsDeleted: string
                globalQuotaDeleted: string
                hasMore: boolean
                visitorQuotaDeleted: string
            }>(sql`
                select
                    deleted_rows::text as "deletedRows",
                    has_more as "hasMore",
                    events_deleted::text as "eventsDeleted",
                    dedupe_deleted::text as "dedupeDeleted",
                    visitor_quota_deleted::text as "visitorQuotaDeleted",
                    global_quota_deleted::text as "globalQuotaDeleted"
                from public.purge_viewer_analytics_retention()
            `),
        ]);
        const row = purgeResults[2].rows[0];
        if (!row || typeof row.hasMore !== 'boolean') {
            throw new Error('Analytics retention purge returned an invalid result');
        }
        deletedRows += parseAnalyticsRetentionCount(row.deletedRows);
        eventsDeleted += parseAnalyticsRetentionCount(row.eventsDeleted);
        dedupeDeleted += parseAnalyticsRetentionCount(row.dedupeDeleted);
        visitorQuotaDeleted += parseAnalyticsRetentionCount(row.visitorQuotaDeleted);
        globalQuotaDeleted += parseAnalyticsRetentionCount(row.globalQuotaDeleted);
        hasMore = row.hasMore;
        batches += 1;
    }

    if (hasMore) {
        throw createError({
            statusCode: 503,
            statusMessage: 'Analytics retention backlog remains after the bounded drain',
        });
    }

    return {
        batches,
        deletedRows: deletedRows.toString(),
        ok: true,
        tables: {
            dedupe: dedupeDeleted.toString(),
            events: eventsDeleted.toString(),
            globalQuota: globalQuotaDeleted.toString(),
            visitorQuota: visitorQuotaDeleted.toString(),
        },
    };
});
