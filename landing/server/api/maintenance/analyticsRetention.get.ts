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
import { getOptionalDb } from '~~/server/db';

export default defineEventHandler(async (event) => {
    setHeader(event, 'cache-control', 'no-store');
    if (!isAnalyticsRetentionRequestAuthorized(
        getHeader(event, 'authorization'),
        process.env.CRON_SECRET,
    )) {
        throw createError({
            statusCode: 401,
            statusMessage: 'Unauthorized',
        });
    }

    const config = useRuntimeConfig(event);
    const db = getOptionalDb(config.databaseUrl ?? process.env.DATABASE_URL);
    if (!db) {
        throw createError({
            statusCode: 503,
            statusMessage: 'Analytics database is unavailable',
        });
    }
    let deletedRows = BigInt(0);
    let pageViewsDeleted = BigInt(0);
    let downloadsDeleted = BigInt(0);
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
                downloadsDeleted: string
                globalQuotaDeleted: string
                hasMore: boolean
                pageViewsDeleted: string
                visitorQuotaDeleted: string
            }>(sql`
                select
                    deleted_rows::text as "deletedRows",
                    has_more as "hasMore",
                    page_views_deleted::text as "pageViewsDeleted",
                    downloads_deleted::text as "downloadsDeleted",
                    dedupe_deleted::text as "dedupeDeleted",
                    visitor_quota_deleted::text as "visitorQuotaDeleted",
                    global_quota_deleted::text as "globalQuotaDeleted"
                from public.purge_landing_analytics_retention()
            `),
        ]);
        const row = purgeResults[2].rows[0];
        if (!row || typeof row.hasMore !== 'boolean') {
            throw new Error('Landing analytics retention purge returned an invalid result');
        }
        deletedRows += parseAnalyticsRetentionCount(row.deletedRows);
        pageViewsDeleted += parseAnalyticsRetentionCount(row.pageViewsDeleted);
        downloadsDeleted += parseAnalyticsRetentionCount(row.downloadsDeleted);
        dedupeDeleted += parseAnalyticsRetentionCount(row.dedupeDeleted);
        visitorQuotaDeleted += parseAnalyticsRetentionCount(row.visitorQuotaDeleted);
        globalQuotaDeleted += parseAnalyticsRetentionCount(row.globalQuotaDeleted);
        hasMore = row.hasMore;
        batches += 1;
    }

    if (hasMore) {
        throw createError({
            statusCode: 503,
            statusMessage: 'Landing analytics retention backlog remains after the bounded drain',
        });
    }

    return {
        batches,
        deletedRows: deletedRows.toString(),
        ok: true,
        tables: {
            dedupe: dedupeDeleted.toString(),
            downloads: downloadsDeleted.toString(),
            globalQuota: globalQuotaDeleted.toString(),
            pageViews: pageViewsDeleted.toString(),
            visitorQuota: visitorQuotaDeleted.toString(),
        },
    };
});
