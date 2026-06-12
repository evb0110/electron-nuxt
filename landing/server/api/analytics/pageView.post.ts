import { getDb } from '~~/server/db';
import { landingPageView } from '~~/server/db/schema';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

interface IPageViewBody {
    path: string
    referrer: string | null
}

function validatePageViewBody(value: unknown): IPageViewBody {
    if (
        !isRecord(value)
        || typeof value.path !== 'string'
        || !value.path
        || (value.referrer !== undefined && value.referrer !== null && typeof value.referrer !== 'string')
    ) {
        throw createError({
            statusCode: 400,
            statusMessage: 'Missing path',
        });
    }

    return {
        path: value.path,
        referrer: typeof value.referrer === 'string' ? value.referrer : null,
    };
}

export default defineEventHandler(async (event) => {
    const config = useRuntimeConfig(event);
    const db = getDb(config.databaseUrl ?? process.env.DATABASE_URL);

    const body = await readValidatedBody(event, validatePageViewBody);

    const {
        geo, visitorHash, userAgent,
    } = await getAnalyticsRequestContext(event);

    await db.insert(landingPageView).values({
        path: body.path.slice(0, 255),
        referrer: body.referrer?.slice(0, 2000) ?? null,
        country: geo.country,
        city: geo.city,
        region: geo.region,
        visitorHash,
        userAgent,
    });

    return { ok: true };
});
