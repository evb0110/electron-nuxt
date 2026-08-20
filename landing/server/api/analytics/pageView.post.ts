import { getOptionalDb } from '~~/server/db';
import { admitLandingAnalyticsEvent } from '~~/server/db/analyticsAdmission';
import { readBoundedLandingAnalyticsJsonBody } from '~~/server/utils/analyticsRequestBody';
import {
    createLandingAnalyticsDedupeKey,
    getAnalyticsRequestContext,
    isLandingAnalyticsAdmissionRejected,
    isLandingAnalyticsWriteAllowed,
    isTrustedLandingAnalyticsRequest,
    LANDING_ANALYTICS_BODY_MAX_BYTES,
    resolveLandingAnalyticsAdmissionPolicy,
} from '~~/server/utils/analytics';

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
        || value.path.length > 255
        || (value.referrer !== undefined && value.referrer !== null && typeof value.referrer !== 'string')
        || (typeof value.referrer === 'string' && value.referrer.length > 1_024)
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
    setHeader(event, 'cache-control', 'no-store');
    if (!isLandingAnalyticsWriteAllowed(event)) {
        return {
            ok: true,
            persisted: false,
        };
    }
    if (!isTrustedLandingAnalyticsRequest(event)) {
        throw createError({
            statusCode: 403,
            statusMessage: 'Analytics request is not same-origin JSON',
        });
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
    const body = validatePageViewBody(rawBody);

    const {
        geo, visitorHash, userAgent,
    } = await getAnalyticsRequestContext(event);
    const policy = resolveLandingAnalyticsAdmissionPolicy('page_view');
    const dedupeKey = await createLandingAnalyticsDedupeKey(
        'page_view',
        visitorHash,
        body,
    );

    try {
        await admitLandingAnalyticsEvent(db, {
            ...policy,
            surface: 'page_view',
            event: {
                path: body.path,
                referrer: body.referrer,
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
        console.warn('Landing page-view analytics insert failed', error);
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
