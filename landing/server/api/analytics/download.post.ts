import { getDb } from '~~/server/db';
import { landingDownload } from '~~/server/db/schema';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

interface IDownloadBody {
    platform: string
    arch: string
    version: string
    fileName: string
}

function validateDownloadBody(value: unknown): IDownloadBody {
    if (
        !isRecord(value)
        || typeof value.platform !== 'string'
        || typeof value.arch !== 'string'
        || typeof value.version !== 'string'
        || typeof value.fileName !== 'string'
        || !value.platform
        || !value.arch
        || !value.version
        || !value.fileName
    ) {
        throw createError({
            statusCode: 400,
            statusMessage: 'Missing required fields',
        });
    }

    return {
        platform: value.platform,
        arch: value.arch,
        version: value.version,
        fileName: value.fileName,
    };
}

export default defineEventHandler(async (event) => {
    const config = useRuntimeConfig(event);
    const db = getDb(config.databaseUrl ?? process.env.DATABASE_URL);

    const body = await readValidatedBody(event, validateDownloadBody);

    const {
        geo, visitorHash, userAgent,
    } = await getAnalyticsRequestContext(event);

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
