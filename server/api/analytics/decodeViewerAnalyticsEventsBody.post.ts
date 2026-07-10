import {
    createError,
    defineEventHandler,
    getHeader,
    setHeader,
} from 'h3';
import { isNotNil } from 'es-toolkit/predicate';
import type {
    JsonArray,
    JsonObject,
    JsonValue,
} from 'type-fest';
import {
    ANALYTICS_EVENT_NAMES,
    type TAnalyticsEventName,
    type TAnalyticsScreenCategory,
    normalizeAnalyticsScalar,
} from '@contracts/analytics';
import { isRecord } from '@contracts/runtimeGuards';
import { getAnalyticsDb } from '@server/db';
import {
    admitViewerAnalyticsEvents,
    type IViewerAnalyticsAdmissionEvent,
} from '@server/db/admitViewerAnalyticsEvents';
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
    ROOT_ANALYTICS_MAX_EVENT_COUNT,
    ROOT_ANALYTICS_USER_AGENT_MAX_LENGTH,
} from '@server/utils/analyticsAdmission';
import { readBoundedAnalyticsJsonBody } from '@server/utils/analyticsRequestBody';
import { getRuntimeEnv } from '@server/utils/getRuntimeEnv';

const VALID_EVENT_NAMES: ReadonlySet<string> = new Set<TAnalyticsEventName>(ANALYTICS_EVENT_NAMES);
const MAX_STRING_LENGTH = 500;
const MAX_REFERRER_LENGTH = 1_024;
const MAX_OBJECT_KEYS = 40;
const MAX_ARRAY_ITEMS = 25;
const MAX_NORMALIZE_DEPTH = 4;

function isAnalyticsEventName(value: string): value is TAnalyticsEventName {
    return VALID_EVENT_NAMES.has(value);
}

function sanitizeString(value: unknown, maxLength: number) {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim();
    return normalized ? normalized.slice(0, maxLength) : null;
}

function sanitizePayloadScalar(value: unknown): JsonValue | undefined {
    return normalizeAnalyticsScalar(value, {
        maxStringLength: MAX_STRING_LENGTH,
        nonFiniteFallback: null,
    });
}

function sanitizePayloadArray(value: unknown[], depth: number): JsonArray {
    return value
        .slice(0, MAX_ARRAY_ITEMS)
        .map(item => sanitizePayloadValue(item, depth + 1));
}

function sanitizePayloadObject(
    value: Record<string, unknown>,
    depth: number,
): JsonObject {
    const normalizedPayload: JsonObject = {};
    for (const [
        key,
        entryValue,
    ] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
        normalizedPayload[key.slice(0, 64)] = sanitizePayloadValue(entryValue, depth + 1);
    }

    return normalizedPayload;
}

function sanitizePayloadContainer(value: unknown, depth: number): JsonValue {
    if (depth >= MAX_NORMALIZE_DEPTH) {
        return null;
    }

    if (Array.isArray(value)) {
        return sanitizePayloadArray(value, depth);
    }

    if (!isRecord(value)) {
        return null;
    }

    return sanitizePayloadObject(value, depth);
}

function sanitizePayloadValue(value: unknown, depth = 0): JsonValue {
    const scalar = sanitizePayloadScalar(value);
    return scalar === undefined
        ? sanitizePayloadContainer(value, depth)
        : scalar;
}

function sanitizePayload(value: unknown): JsonObject {
    return isRecord(value) ? sanitizePayloadObject(value, 0) : {};
}

function parseClientOccurredAt(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseEventEnvelope(value: unknown): IViewerAnalyticsAdmissionEvent | null {
    if (!isRecord(value)) {
        return null;
    }

    const name = sanitizeString(value.name, 80);
    if (!name || !isAnalyticsEventName(name)) {
        return null;
    }

    const path = sanitizeString(value.path, 255) ?? '/';
    const locale = sanitizeString(value.locale, 16);
    const referrer = sanitizeString(value.referrer, MAX_REFERRER_LENGTH);
    const screenCategoryValue = sanitizeString(value.screenCategory, 16);
    const screenCategory: TAnalyticsScreenCategory = (
        screenCategoryValue === 'mobile'
        || screenCategoryValue === 'tablet'
        || screenCategoryValue === 'desktop'
    )
        ? screenCategoryValue
        : 'desktop';
    const sessionId = sanitizeString(value.sessionId, 64);
    if (!sessionId) {
        return null;
    }

    return {
        name,
        clientOccurredAt: parseClientOccurredAt(value.occurredAt),
        path,
        locale,
        referrer,
        screenCategory,
        sessionId,
        payload: sanitizePayload(value.payload),
    };
}

export function decodeViewerAnalyticsEventsBody(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.events)) {
        return [];
    }
    if (value.events.length > ROOT_ANALYTICS_MAX_EVENT_COUNT) {
        throw createError({
            statusCode: 400,
            statusMessage: `Analytics batches may contain at most ${ROOT_ANALYTICS_MAX_EVENT_COUNT} events`,
        });
    }
    return value.events
        .map(entry => parseEventEnvelope(entry))
        .filter(isNotNil);
}

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
