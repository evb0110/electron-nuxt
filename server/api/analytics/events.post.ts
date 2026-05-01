import {
    defineEventHandler,
    getHeader,
    readBody,
    setHeader,
} from 'h3';
import {
    ANALYTICS_EVENT_NAMES,
    type IAnalyticsEventEnvelope,
    type TAnalyticsEventName,
    type TAnalyticsPayloadValue,
    type TAnalyticsScreenCategory,
} from '@app/types/analytics';
import { normalizeAnalyticsScalar } from '@contracts/analytics';
import { getAnalyticsDb } from '../../db';
import { viewerAnalyticsEvent } from '../../db/schema';
import {
    extractGeo,
    getAnalyticsRequestHost,
    hashVisitorIdentity,
    isAnalyticsWriteAllowed,
} from '../../utils/analytics';

const VALID_EVENT_NAMES = new Set<TAnalyticsEventName>(ANALYTICS_EVENT_NAMES);
const MAX_EVENT_COUNT = 20;
const MAX_STRING_LENGTH = 2_000;
const MAX_OBJECT_KEYS = 40;
const MAX_ARRAY_ITEMS = 25;
const MAX_NORMALIZE_DEPTH = 4;

type TViewerAnalyticsInsert = typeof viewerAnalyticsEvent.$inferInsert;
type TSanitizedPayloadEntry = [string, unknown];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeString(value: unknown, maxLength: number) {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim();
    return normalized ? normalized.slice(0, maxLength) : null;
}

function sanitizePayloadScalar(value: unknown) {
    return normalizeAnalyticsScalar(value, {
        maxStringLength: MAX_STRING_LENGTH,
        nonFiniteFallback: null,
    });
}

function sanitizePayloadArray(value: unknown[], depth: number) {
    return value
        .slice(0, MAX_ARRAY_ITEMS)
        .map(item => sanitizePayloadValue(item, depth + 1));
}

function sanitizePayloadObject(value: Record<string, unknown>, depth: number) {
    const normalizedEntries: TSanitizedPayloadEntry[] = [];
    for (const [
        key,
        entryValue,
    ] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
        normalizedEntries.push([
            key.slice(0, 64),
            sanitizePayloadValue(entryValue, depth + 1),
        ]);
    }

    return Object.fromEntries(normalizedEntries);
}

function sanitizePayloadContainer(value: unknown, depth: number) {
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

function sanitizePayloadValue(value: unknown, depth = 0): unknown {
    const scalar = sanitizePayloadScalar(value);
    return scalar === undefined
        ? sanitizePayloadContainer(value, depth)
        : scalar;
}

function sanitizePayload(value: unknown) {
    const normalized = sanitizePayloadValue(value);
    return (isRecord(normalized) ? normalized : {}) as Record<string, TAnalyticsPayloadValue>;
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
    if (!name || !VALID_EVENT_NAMES.has(name as TAnalyticsEventName)) {
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
        name: name as TAnalyticsEventName,
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
        .filter((entry): entry is IAnalyticsEventEnvelope => entry !== null);
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
        const rows: TViewerAnalyticsInsert[] = parsedEvents.map(entry => ({
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
        }));

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
