import { getOptionalDb } from '~~/server/db';
import { landingDownload } from '~~/server/db/schema';
import type {
    TReleaseArch,
    TReleasePlatform,
} from '~~/vendor/contracts/release';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

interface IDownloadBody {
    platform: TReleasePlatform
    arch: TReleaseArch
    version: string
    fileName: string
}

const DOWNLOAD_PLATFORMS = new Set<TReleasePlatform>(['macos', 'windows', 'linux', 'unknown']);
const DOWNLOAD_ARCHES = new Set<TReleaseArch>(['arm64', 'x64', 'universal', 'unknown']);

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
        || !DOWNLOAD_PLATFORMS.has(value.platform as TReleasePlatform)
        || !DOWNLOAD_ARCHES.has(value.arch as TReleaseArch)
    ) {
        throw createError({
            statusCode: 400,
            statusMessage: 'Missing required fields',
        });
    }

    return {
        platform: value.platform as TReleasePlatform,
        arch: value.arch as TReleaseArch,
        version: value.version,
        fileName: value.fileName,
    };
}

export default defineEventHandler(async (event) => {
    const body = await readValidatedBody(event, validateDownloadBody);
    const config = useRuntimeConfig(event);
    const db = getOptionalDb(config.databaseUrl ?? process.env.DATABASE_URL);
    if (!db) {
        return { ok: true };
    }

    const {
        geo, visitorHash, userAgent,
    } = await getAnalyticsRequestContext(event);

    try {
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
    } catch (error) {
        console.warn('Landing download analytics insert failed', error);
    }

    return { ok: true };
});
