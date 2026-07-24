import { getOptionalDb } from '~~/server/db';
import { admitLandingAnalyticsEvent } from '~~/server/db/analyticsAdmission';
import { readBoundedLandingAnalyticsJsonBody } from '~~/server/utils/analyticsRequestBody';
import {
    createLandingAnalyticsDedupeKey,
    getAnalyticsRequestContext,
    isLandingAnalyticsAdmissionRejected,
    isLandingAnalyticsWriteAllowed,
    LANDING_ANALYTICS_BODY_MAX_BYTES,
    resolveLandingAnalyticsAdmissionPolicy,
} from '~~/server/utils/analytics';
import {
    RELEASE_ARCHES,
    RELEASE_PLATFORMS,
} from '@contracts/release';
import type {
    TReleaseArch,
    TReleasePlatform,
} from '@contracts/release';
import { isOneOf } from '@contracts/runtimeGuards';

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
        || value.version.length > 50
        || value.fileName.length > 255
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
    if (!isLandingAnalyticsWriteAllowed(event)) {
        return {
            ok: true,
            persisted: false,
        };
    }
    const config = useRuntimeConfig(event);
    const db = getOptionalDb(config.databaseUrl ?? process.env.DATABASE_URL);
    if (!db) {
        return {
            ok: true,
            persisted: false,
        };
    }
    const rawBody = await readBoundedLandingAnalyticsJsonBody(
        event,
        LANDING_ANALYTICS_BODY_MAX_BYTES,
    );
    const body = validateDownloadBody(rawBody);

    const {
        geo, visitorHash, userAgent,
    } = await getAnalyticsRequestContext(event);
    const policy = resolveLandingAnalyticsAdmissionPolicy('download');
    const dedupeKey = await createLandingAnalyticsDedupeKey(
        'download',
        visitorHash,
        body,
    );

    try {
        await admitLandingAnalyticsEvent(db, {
            ...policy,
            surface: 'download',
            event: {
                platform: body.platform,
                arch: body.arch,
                version: body.version,
                fileName: body.fileName,
            },
            country: geo.country,
            city: geo.city,
            region: geo.region,
            visitorHash,
            userAgent,
            dedupeKey,
        });
    } catch (error) {
        if (isLandingAnalyticsAdmissionRejected(error)) {
            return {
                ok: true,
                persisted: false,
            };
        }
        console.warn('Landing download analytics insert failed', error);
        return {
            ok: false,
            persisted: false,
        };
    }

    return {
        ok: true,
        persisted: true,
    };
});
