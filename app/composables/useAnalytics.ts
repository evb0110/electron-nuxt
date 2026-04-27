import { createUuid } from '@app/utils/uuid';
import type {
    IAnalyticsDocumentContext,
    IAnalyticsEventEnvelope,
    TAnalyticsEventName,
    TAnalyticsPayloadValue,
    TAnalyticsScreenCategory,
} from '@app/types/analytics';
import { isBrowserPlatformActive } from '@app/utils/platform';

const ANALYTICS_SESSION_STORAGE_KEY = 'evb-viewer:analytics-session-id';
const MAX_BATCH_SIZE = 20;
const MAX_QUEUE_SIZE = 100;
const MAX_OBJECT_KEYS = 40;
const MAX_ARRAY_ITEMS = 25;
const MAX_STRING_LENGTH = 500;
const MAX_NORMALIZE_DEPTH = 4;
const FLUSH_DELAY_MS = 1_500;

interface IAnalyticsBrowserState {
    documentContext: IAnalyticsDocumentContext | null;
    flushTimer: number | null;
    isFlushing: boolean;
    lifecycleInstalled: boolean;
    queue: IAnalyticsEventEnvelope[];
    sessionId: string | null;
}

type TNormalizedAnalyticsEntry = readonly [string, TAnalyticsPayloadValue];

const analyticsBrowserState: IAnalyticsBrowserState = {
    documentContext: null,
    flushTimer: null,
    isFlushing: false,
    lifecycleInstalled: false,
    queue: [],
    sessionId: null,
};

function isTruthyFlag(value: unknown) {
    return value === true
        || value === 1
        || value === '1'
        || value === 'true';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) {
        return false;
    }

    if (Object.prototype.toString.call(value) !== '[object Object]') {
        return false;
    }

    const constructor = Reflect.get(value, 'constructor');
    return constructor === undefined || constructor === Object;
}

function normalizePayloadValue(
    value: unknown,
    depth = 0,
): TAnalyticsPayloadValue | undefined {
    if (value === null) {
        return null;
    }

    if (typeof value === 'string') {
        return value.slice(0, MAX_STRING_LENGTH);
    }

    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }

    if (depth >= MAX_NORMALIZE_DEPTH) {
        return undefined;
    }

    if (Array.isArray(value)) {
        return value
            .slice(0, MAX_ARRAY_ITEMS)
            .map(item => normalizePayloadValue(item, depth + 1))
            .filter((item): item is TAnalyticsPayloadValue => item !== undefined);
    }

    if (!isPlainObject(value)) {
        return undefined;
    }

    const normalizedEntries: TNormalizedAnalyticsEntry[] = [];
    for (const entry of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
        const key = entry[0];
        const entryValue = entry[1];
        const normalizedValue = normalizePayloadValue(entryValue, depth + 1);
        if (normalizedValue === undefined) {
            continue;
        }

        normalizedEntries.push([
            key.slice(0, 64),
            normalizedValue,
        ] as const);
    }

    return Object.fromEntries(normalizedEntries);
}

function normalizePayload(
    payload: Record<string, unknown> | undefined,
): Record<string, TAnalyticsPayloadValue> {
    if (!payload) {
        return {};
    }

    const normalizedValue = normalizePayloadValue(payload);
    return isPlainObject(normalizedValue) ? normalizedValue : {};
}

function normalizeDocumentContext(
    context: Partial<IAnalyticsDocumentContext>,
): IAnalyticsDocumentContext {
    return normalizePayload(context as Record<string, unknown>) as IAnalyticsDocumentContext;
}

function getScreenCategory(width: number): TAnalyticsScreenCategory {
    if (width < 768) {
        return 'mobile';
    }
    if (width < 1200) {
        return 'tablet';
    }
    return 'desktop';
}

function isClientAnalyticsEnabled(enabledFlag: unknown) {
    return import.meta.client
        && isBrowserPlatformActive()
        && isTruthyFlag(enabledFlag);
}

function getBrowserLocale() {
    const documentLocale = document.documentElement.lang.trim();
    if (documentLocale) {
        return documentLocale;
    }

    const [preferredLanguage] = navigator.languages;
    if (typeof preferredLanguage === 'string' && preferredLanguage.trim()) {
        return preferredLanguage;
    }

    return typeof navigator.language === 'string' && navigator.language.trim()
        ? navigator.language
        : null;
}

function getSessionId() {
    if (!import.meta.client) {
        return 'server';
    }

    if (analyticsBrowserState.sessionId) {
        return analyticsBrowserState.sessionId;
    }

    try {
        const existingValue = window.sessionStorage.getItem(ANALYTICS_SESSION_STORAGE_KEY);
        if (existingValue) {
            analyticsBrowserState.sessionId = existingValue;
            return existingValue;
        }
    } catch {
        // Session storage is optional in constrained browser environments.
    }

    const nextValue = createUuid();
    analyticsBrowserState.sessionId = nextValue;

    try {
        window.sessionStorage.setItem(ANALYTICS_SESSION_STORAGE_KEY, nextValue);
    } catch {
        // Best-effort only.
    }

    return nextValue;
}

function clearFlushTimer() {
    if (analyticsBrowserState.flushTimer) {
        clearTimeout(analyticsBrowserState.flushTimer);
        analyticsBrowserState.flushTimer = null;
    }
}

async function postAnalyticsBatch(
    events: IAnalyticsEventEnvelope[],
    useBeacon = false,
) {
    if (!import.meta.client || events.length === 0) {
        return true;
    }

    const body = JSON.stringify({ events });

    if (useBeacon && typeof navigator.sendBeacon === 'function') {
        return navigator.sendBeacon(
            '/api/analytics/events',
            new Blob([body], { type: 'application/json' }),
        );
    }

    const response = await fetch('/api/analytics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
    });

    return response.ok;
}

async function flushAnalyticsQueue(enabledFlag: unknown, useBeacon = false) {
    if (!isClientAnalyticsEnabled(enabledFlag) || analyticsBrowserState.queue.length === 0) {
        return;
    }

    if (analyticsBrowserState.isFlushing && !useBeacon) {
        return;
    }

    clearFlushTimer();

    const batch = analyticsBrowserState.queue.splice(0, MAX_BATCH_SIZE);
    if (batch.length === 0) {
        return;
    }

    if (!useBeacon) {
        analyticsBrowserState.isFlushing = true;
    }

    try {
        const didPersist = await postAnalyticsBatch(batch, useBeacon);
        if (!didPersist) {
            analyticsBrowserState.queue = [
                ...batch,
                ...analyticsBrowserState.queue,
            ].slice(0, MAX_QUEUE_SIZE);
        }
    } catch {
        analyticsBrowserState.queue = [
            ...batch,
            ...analyticsBrowserState.queue,
        ].slice(0, MAX_QUEUE_SIZE);
    } finally {
        if (!useBeacon) {
            analyticsBrowserState.isFlushing = false;
        }
    }
}

function ensureAnalyticsLifecycle(enabledFlag: unknown) {
    if (!isClientAnalyticsEnabled(enabledFlag) || analyticsBrowserState.lifecycleInstalled) {
        return;
    }

    analyticsBrowserState.lifecycleInstalled = true;

    const flushWithBeacon = () => {
        void flushAnalyticsQueue(enabledFlag, true);
    };

    window.addEventListener('pagehide', flushWithBeacon);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            flushWithBeacon();
        }
    });
}

function getAnalyticsEnabledFlagFromRuntimeConfig() {
    if (typeof useRuntimeConfig !== 'function') {
        return false;
    }

    return useRuntimeConfig().public?.analyticsEnabled ?? false;
}

export function useAnalytics() {
    const enabledFlag = getAnalyticsEnabledFlagFromRuntimeConfig();

    function mergeDocumentContext(nextContext: Partial<IAnalyticsDocumentContext>) {
        if (!isClientAnalyticsEnabled(enabledFlag)) {
            return;
        }

        analyticsBrowserState.documentContext = {
            ...(analyticsBrowserState.documentContext ?? {}),
            ...normalizeDocumentContext(nextContext),
        };
    }

    function setDocumentContext(nextContext: IAnalyticsDocumentContext | null) {
        if (!isClientAnalyticsEnabled(enabledFlag)) {
            return;
        }

        analyticsBrowserState.documentContext = nextContext
            ? normalizeDocumentContext(nextContext)
            : null;
    }

    function clearDocumentContext() {
        analyticsBrowserState.documentContext = null;
    }

    function track(
        name: TAnalyticsEventName,
        payload?: Record<string, unknown>,
        options?: {
            includeReferrer?: boolean;
            path?: string;
        },
    ) {
        if (!isClientAnalyticsEnabled(enabledFlag)) {
            return;
        }

        ensureAnalyticsLifecycle(enabledFlag);

        const locale = getBrowserLocale();
        const normalizedPayload = normalizePayload({
            ...(analyticsBrowserState.documentContext ?? {}),
            ...(payload ?? {}),
        });

        analyticsBrowserState.queue.push({
            name,
            occurredAt: new Date().toISOString(),
            path: (options?.path ?? window.location.pathname).slice(0, 255),
            locale: typeof locale === 'string' ? locale.slice(0, 16) : null,
            referrer: options?.includeReferrer ? (document.referrer || null) : null,
            screenCategory: getScreenCategory(window.innerWidth),
            sessionId: getSessionId(),
            payload: normalizedPayload,
        });

        if (analyticsBrowserState.queue.length > MAX_QUEUE_SIZE) {
            analyticsBrowserState.queue = analyticsBrowserState.queue.slice(-MAX_QUEUE_SIZE);
        }

        if (analyticsBrowserState.queue.length >= MAX_BATCH_SIZE) {
            void flushAnalyticsQueue(enabledFlag);
            return;
        }

        if (!analyticsBrowserState.flushTimer) {
            analyticsBrowserState.flushTimer = window.setTimeout(() => {
                analyticsBrowserState.flushTimer = null;
                void flushAnalyticsQueue(enabledFlag);
            }, FLUSH_DELAY_MS);
        }
    }

    return {
        clearDocumentContext,
        enabled: isClientAnalyticsEnabled(enabledFlag),
        flush: (useBeacon = false) => flushAnalyticsQueue(enabledFlag, useBeacon),
        installLifecycle: () => ensureAnalyticsLifecycle(enabledFlag),
        mergeDocumentContext,
        setDocumentContext,
        track,
    };
}
