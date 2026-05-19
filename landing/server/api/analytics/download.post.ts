import { getHeader } from 'h3';
import { getDb } from '~~/server/db';
import { landingDownload } from '~~/server/db/schema';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export default defineEventHandler(async (event) => {
    const config = useRuntimeConfig(event);
    const db = getDb(config.databaseUrl || process.env.DATABASE_URL);

    const body = await readBody(event);

    if (
        !isRecord(body)
        || typeof body.platform !== 'string'
        || typeof body.arch !== 'string'
        || typeof body.version !== 'string'
        || typeof body.fileName !== 'string'
        || !body.platform
        || !body.arch
        || !body.version
        || !body.fileName
    ) {
        throw createError({
            statusCode: 400,
            statusMessage: 'Missing required fields', 
        });
    }

    const geo = extractGeo(event);
    const visitorHash = await hashVisitorIdentity(event);
    const userAgent = getHeader(event, 'user-agent') ?? null;

    await db.insert(landingDownload).values({
        platform: body.platform.slice(0, 20),
        arch: body.arch.slice(0, 20),
        version: body.version.slice(0, 50),
        fileName: body.fileName.slice(0, 255),
        country: geo.country,
        city: geo.city,
        region: geo.region,
        visitorHash,
        userAgent,
    });

    return { ok: true };
});
