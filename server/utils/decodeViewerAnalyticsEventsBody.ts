import { createError } from 'h3';
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
import type { IViewerAnalyticsAdmissionEvent } from '@server/db/admitViewerAnalyticsEvents';
import { ROOT_ANALYTICS_MAX_EVENT_COUNT } from '@server/utils/analyticsAdmission';

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
