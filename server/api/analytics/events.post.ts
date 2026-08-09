import {
    defineEventHandler,
    getHeader,
    setHeader,
} from 'h3';
import { getAnalyticsDb } from '@server/db';
import { admitViewerAnalyticsEvents } from '@server/db/admitViewerAnalyticsEvents';
import {
    extractGeo,
    getAnalyticsRequestHost,
    hashVisitorIdentity,
    isAnalyticsWriteAllowed,
} from '@server/utils/analytics';
import {
    createAnalyticsDedupeKey,
    isAnalyticsAdmissionRejected,
    resolveRootAnalyticsAdmissionPolicy,
    ROOT_ANALYTICS_BODY_MAX_BYTES,
    ROOT_ANALYTICS_USER_AGENT_MAX_LENGTH,
} from '@server/utils/analyticsAdmission';
import { readBoundedAnalyticsJsonBody } from '@server/utils/analyticsRequestBody';
import { decodeViewerAnalyticsEventsBody } from '@server/utils/decodeViewerAnalyticsEventsBody';
import { getRuntimeEnv } from '@server/utils/getRuntimeEnv';

export default defineEventHandler(async (event) => {
    setHeader(event, 'cache-control', 'no-store');

    if (!isAnalyticsWriteAllowed(event)) {
        return {
            ok: true,
            persisted: false,
        };
    }

    const body = await readBoundedAnalyticsJsonBody(event, ROOT_ANALYTICS_BODY_MAX_BYTES);
    const parsedEvents = decodeViewerAnalyticsEventsBody(body);
    if (parsedEvents.length === 0) {
        return {
            ok: true,
            persisted: false,
        };
    }

    const geo = extractGeo(event);
    const visitorHash = await hashVisitorIdentity(event);
    const userAgent = getHeader(event, 'user-agent')?.slice(0, ROOT_ANALYTICS_USER_AGENT_MAX_LENGTH) ?? null;
    const deploymentHost = getAnalyticsRequestHost(event);
    const policy = resolveRootAnalyticsAdmissionPolicy(getRuntimeEnv());
    const dedupeKey = await createAnalyticsDedupeKey(
        'viewer_events',
        visitorHash,
        parsedEvents,
    );

    try {
        const db = getAnalyticsDb(event);
        await admitViewerAnalyticsEvents(db, {
            ...policy,
            events: parsedEvents,
            visitorHash,
            deploymentHost,
            userAgent,
            country: geo.country,
            city: geo.city,
            region: geo.region,
            dedupeKey,
        });
    } catch (error) {
        if (isAnalyticsAdmissionRejected(error)) {
            return {
                ok: true,
                persisted: false,
            };
        }
        console.error('viewer analytics insert failed', error);
        return {
            ok: false,
            persisted: false,
        };
    }

    return {
        ok: true,
        persisted: true,
        count: parsedEvents.length,
    };
});
