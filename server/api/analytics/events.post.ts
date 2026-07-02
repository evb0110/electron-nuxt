import {
    defineEventHandler,
    getHeader,
    readBody,
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
    type IAnalyticsEventEnvelope,
    type TAnalyticsEventName,
    type TAnalyticsScreenCategory,
    normalizeAnalyticsScalar,
} from '@contracts/analytics';
import { isRecord } from '@contracts/runtimeGuards';
import { getAnalyticsDb } from '@server/db';
import { viewerAnalyticsEvent } from '@server/db/viewerAnalyticsEvent';
import {
    extractGeo,
    getAnalyticsRequestHost,
    hashVisitorIdentity,
    isAnalyticsWriteAllowed,
} from '@server/utils/analytics';

const VALID_EVENT_NAMES: ReadonlySet<string> = new Set<TAnalyticsEventName>(ANALYTICS_EVENT_NAMES);
const MAX_EVENT_COUNT = 20;
const MAX_STRING_LENGTH = 2_000;
const MAX_OBJECT_KEYS = 40;
const MAX_ARRAY_ITEMS = 25;
const MAX_NORMALIZE_DEPTH = 4;

type TViewerAnalyticsInsert = typeof viewerAnalyticsEvent.$inferInsert;

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

function parseOccurredAt(value: unknown) {
    if (typeof value !== 'string') {
        return new Date();
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function parseEventEnvelope(value: unknown): IAnalyticsEventEnvelope | null {
    if (!isRecord(value)) {
        return null;
    }

    const name = sanitizeString(value.name, 80);
    if (!name || !isAnalyticsEventName(name)) {
        return null;
    }

    const path = sanitizeString(value.path, 255) ?? '/';
    const locale = sanitizeString(value.locale, 16);
    const referrer = sanitizeString(value.referrer, MAX_STRING_LENGTH);
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
        occurredAt: parseOccurredAt(value.occurredAt).toISOString(),
        path,
        locale,
        referrer,
        screenCategory,
        sessionId,
        payload: sanitizePayload(value.payload),
    };
}

export default defineEventHandler(async (event) => {
    setHeader(event, 'cache-control', 'no-store');

    if (!isAnalyticsWriteAllowed(event)) {
        return {
            ok: true,
            persisted: false,
        };
    }

    const body = await readBody<{ events?: unknown }>(event);
    const rawEvents = Array.isArray(body?.events)
        ? body.events.slice(0, MAX_EVENT_COUNT)
        : [];
    if (rawEvents.length === 0) {
        return {
            ok: true,
            persisted: false,
        };
    }

    const parsedEvents = rawEvents
        .map(entry => parseEventEnvelope(entry))
        .filter(isNotNil);
    if (parsedEvents.length === 0) {
        return {
            ok: true,
            persisted: false,
        };
    }

    const geo = extractGeo(event);
    const visitorHash = await hashVisitorIdentity(event);
    const userAgent = getHeader(event, 'user-agent') ?? null;
    const deploymentHost = getAnalyticsRequestHost(event);

    try {
        const db = getAnalyticsDb(event);
        const rows = parsedEvents.map(entry => ({
            eventName: entry.name,
            path: entry.path,
            locale: entry.locale,
            screenCategory: entry.screenCategory,
            sessionId: entry.sessionId,
            referrer: entry.referrer,
            country: geo.country,
            city: geo.city,
            region: geo.region,
            visitorHash,
            deploymentHost,
            userAgent,
            payload: entry.payload,
            occurredAt: new Date(entry.occurredAt),
        })) satisfies TViewerAnalyticsInsert[];

        await db.insert(viewerAnalyticsEvent).values(rows);
    } catch (error) {
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
