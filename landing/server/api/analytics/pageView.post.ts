import { getHeader } from 'h3';
import { getDb } from '~~/server/db';
import { landingPageView } from '~~/server/db/schema';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export default defineEventHandler(async (event) => {
    const config = useRuntimeConfig(event);
    const db = getDb(config.databaseUrl || process.env.DATABASE_URL);

    const body = await readBody(event);

    if (
        !isRecord(body)
        || typeof body.path !== 'string'
        || !body.path
        || (body.referrer !== undefined && body.referrer !== null && typeof body.referrer !== 'string')
    ) {
        throw createError({
            statusCode: 400,
            statusMessage: 'Missing path', 
        });
    }

    const geo = extractGeo(event);
    const visitorHash = await hashVisitorIdentity(event);
    const userAgent = getHeader(event, 'user-agent') ?? null;

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
