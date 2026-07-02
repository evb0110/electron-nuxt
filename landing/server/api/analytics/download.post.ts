import { getOptionalDb } from '~~/server/db';
import { landingDownload } from '~~/server/db/schema';
import {
    RELEASE_ARCHES,
    RELEASE_PLATFORMS,
} from '~~/vendor/contracts/release';
import type {
    TReleaseArch,
    TReleasePlatform,
} from '~~/vendor/contracts/release';
import { isOneOf } from '~~/vendor/contracts/runtimeGuards';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

interface IDownloadBody {
    platform: TReleasePlatform
    arch: TReleaseArch
    version: string
    fileName: string
}

function validateDownloadBody(value: unknown): IDownloadBody {
    if (
        !isRecord(value)
        || typeof value.version !== 'string'
        || typeof value.fileName !== 'string'
        || !value.version
        || !value.fileName
        || !isOneOf(RELEASE_PLATFORMS, value.platform)
        || !isOneOf(RELEASE_ARCHES, value.arch)
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
