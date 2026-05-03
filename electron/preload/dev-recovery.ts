interface IReloadEvent {
    timestamp: number;
    reason: string;
    blocked: boolean;
    blockReason?: string;
    reloadId: string;
    href?: string;
    timeSincePageLoadMs?: number;
}

interface IReloadDecision {
    allowed: boolean;
    blockReason?: string;
}

interface IWindowWithReloadHistory extends Window {__reloadHistory?: IReloadEvent[];}
interface IDevReloadEventMarker {
    timestamp: number;
    event?: string;
    payload?: unknown;
}

interface IRecentViteFullReloadEvent {
    timestamp: number;
    ageMs: number;
    event: string;
}

type TDevRecoveryLogger = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
) => void;

interface IInstallDevRecoveryOptions { log?: TDevRecoveryLogger; }

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isReloadEvent(value: unknown): value is IReloadEvent {
    return isRecord(value)
        && typeof value.timestamp === 'number'
        && typeof value.reason === 'string'
        && typeof value.reloadId === 'string'
        && typeof value.blocked === 'boolean';
}

/**
 * In development, Vite can transiently fail module fetches after dependency optimize changes.
 * This recovery logic does a bounded auto-reload with guardrails to avoid loops.
 */
export function installViteOutdatedOptimizeDepRecovery(options: IInstallDevRecoveryOptions = {}) {
    if (!process.defaultApp) {
        return;
    }
    if (typeof window === 'undefined') {
        return;
    }

    const RELOAD_KEY = 'evb-viewer:dev:optimize-dep-reload';
    const RELOAD_COOLDOWN_MS = 10_000;
    const INITIAL_LOAD_GRACE_MS = 1_000;
    const MAX_RELOADS_KEY = 'evb-viewer:dev:reload-count';
    const MAX_RELOADS_PER_SESSION = 3;
    const RELOAD_HISTORY_KEY = 'evb-viewer:dev:reload-history:pending';
    const DEV_RELOAD_EVENT_KEY = 'evb-viewer:dev:last-vite-reload-event';
    const MAX_RELOAD_HISTORY = 20;
    const VITE_FULL_RELOAD_EVENT_MAX_AGE_MS = 15_000;
    const log = options.log ?? ((level, message, data) => {
        if (level === 'debug') {
            if (data) {
                console.debug(message, data);
            } else {
                console.debug(message);
            }
            return;
        }
        if (level === 'info') {
            if (data) {
                console.info(message, data);
            } else {
                console.info(message);
            }
            return;
        }
        if (level === 'warn') {
            if (data) {
                console.warn(message, data);
            } else {
                console.warn(message);
            }
            return;
        }
        if (data) {
            console.error(message, data);
        } else {
            console.error(message);
        }
    });

    const reloadHistory: IReloadEvent[] = [];
    (window as IWindowWithReloadHistory).__reloadHistory = reloadHistory;

    const pageLoadTime = Date.now();

    function readPersistedReloadHistory() {
        try {
            const raw = window.sessionStorage.getItem(RELOAD_HISTORY_KEY);
            if (!raw) {
                return [];
            }
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed
                .filter(isReloadEvent)
                .slice(-MAX_RELOAD_HISTORY);
        } catch {
            return [];
        }
    }

    function persistReloadHistory() {
        try {
            window.sessionStorage.setItem(
                RELOAD_HISTORY_KEY,
                JSON.stringify(reloadHistory.slice(-MAX_RELOAD_HISTORY)),
            );
        } catch {
            // sessionStorage may be unavailable
        }
    }

    function appendReloadHistory(event: IReloadEvent) {
        reloadHistory.push(event);
        if (reloadHistory.length > MAX_RELOAD_HISTORY) {
            reloadHistory.splice(0, reloadHistory.length - MAX_RELOAD_HISTORY);
        }
        persistReloadHistory();
    }

    const previousReloadHistory = readPersistedReloadHistory();
    if (previousReloadHistory.length > 0) {
        log('warn', '[Dev] Previous renderer session reload history (persisted)', {previousReloadHistory});
    }

    function getViteReloadPayloadType(payload: unknown) {
        return isRecord(payload)
            ? payload.type
            : undefined;
    }

    function isRecentReloadMarker(marker: IDevReloadEventMarker) {
        if (typeof marker.timestamp !== 'number') {
            return false;
        }

        const ageMs = Date.now() - marker.timestamp;
        return ageMs >= 0 && ageMs <= VITE_FULL_RELOAD_EVENT_MAX_AGE_MS;
    }

    function normalizeRecentViteReloadMarker(
        marker: IDevReloadEventMarker,
    ): IRecentViteFullReloadEvent | null {
        if (!isRecentReloadMarker(marker)) {
            return null;
        }

        const payloadType = getViteReloadPayloadType(marker.payload);
        const isFullReload = marker.event === 'vite:beforeFullReload'
            && (payloadType === 'full-reload' || payloadType === undefined);
        if (!isFullReload) {
            return null;
        }

        return {
            timestamp: marker.timestamp,
            ageMs: Date.now() - marker.timestamp,
            event: marker.event ?? 'vite:beforeFullReload',
        };
    }

    function readSessionStorageItem(key: string) {
        try {
            return window.sessionStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function parseViteReloadMarker(raw: string | null) {
        if (!raw) {
            return null;
        }

        try {
            const parsed = JSON.parse(raw);
            if (!isRecord(parsed) || typeof parsed.timestamp !== 'number') {
                return null;
            }

            return normalizeRecentViteReloadMarker({
                timestamp: parsed.timestamp,
                event: typeof parsed.event === 'string' ? parsed.event : undefined,
                payload: parsed.payload,
            });
        } catch {
            return null;
        }
    }

    function readRecentViteFullReloadEvent() {
        return parseViteReloadMarker(readSessionStorageItem(DEV_RELOAD_EVENT_KEY));
    }

    function isViteOptimizeDepError(message: string) {
        return message.includes('Outdated Optimize Dep');
    }

    function shouldReloadNow(): IReloadDecision {
        try {
            const timeSinceLoad = Date.now() - pageLoadTime;
            if (timeSinceLoad < INITIAL_LOAD_GRACE_MS) {
                return {
                    allowed: false,
                    blockReason: `Within initial load grace period (${timeSinceLoad}ms < ${INITIAL_LOAD_GRACE_MS}ms)`,
                };
            }

            const reloadCount = Number(window.sessionStorage.getItem(MAX_RELOADS_KEY) ?? '0');
            if (reloadCount >= MAX_RELOADS_PER_SESSION) {
                return {
                    allowed: false,
                    blockReason: `Maximum reloads exceeded (${reloadCount} >= ${MAX_RELOADS_PER_SESSION})`,
                };
            }

            const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0');
            if (Number.isFinite(last) && last > 0 && Date.now() - last < RELOAD_COOLDOWN_MS) {
                return {
                    allowed: false,
                    blockReason: `Cooldown active (${Date.now() - last}ms < ${RELOAD_COOLDOWN_MS}ms)`,
                };
            }

            window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
            window.sessionStorage.setItem(MAX_RELOADS_KEY, String(reloadCount + 1));
            return { allowed: true };
        } catch {
            return { allowed: true };
        }
    }

    function scheduleReload(reason: string) {
        const reloadId = `reload-${crypto.randomUUID()}`;
        const baseEvent = {
            timestamp: Date.now(),
            reason,
            reloadId,
            href: window.location?.href ?? '',
            timeSincePageLoadMs: Date.now() - pageLoadTime,
        } satisfies Omit<IReloadEvent, 'blocked'>;

        if (!window.location?.href?.includes('localhost:')) {
            appendReloadHistory({
                ...baseEvent,
                blocked: true,
                blockReason: 'Not running on localhost',
            });
            log('debug', '[Dev] Reload blocked: not running on localhost', {
                reloadId,
                href: window.location?.href ?? '',
            });
            return;
        }

        const recentViteReloadEvent = readRecentViteFullReloadEvent();
        if (recentViteReloadEvent) {
            appendReloadHistory({
                ...baseEvent,
                blocked: true,
                blockReason: `Vite full reload already announced ${recentViteReloadEvent.ageMs}ms ago`,
            });
            log('info', '[Dev] Reload skipped because Vite already announced full reload', {
                reloadId,
                reason,
                recentViteReloadEvent,
            });
            return;
        }

        const decision = shouldReloadNow();
        if (!decision.allowed) {
            appendReloadHistory({
                ...baseEvent,
                blocked: true,
                blockReason: decision.blockReason,
            });
            log('debug', '[Dev] Reload blocked by guardrails', {
                reloadId,
                reason,
                blockReason: decision.blockReason,
            });
            return;
        }

        appendReloadHistory({
            ...baseEvent,
            blocked: false,
        });

        log('warn', '[Dev] Recovering from Vite optimize-deps error; scheduling reload', {
            reloadId,
            reason,
        });
        try {
            log('debug', '[Dev] Reload scheduled cooldown state', {
                reloadId,
                scheduledAt: new Date().toISOString(),
                lastReload: window.sessionStorage.getItem(RELOAD_KEY),
                timeSinceLastReload: Date.now() - Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0'),
                reloadCount: window.sessionStorage.getItem(MAX_RELOADS_KEY),
            });
        } catch {
            // sessionStorage may be unavailable
        }

        setTimeout(() => {
            persistReloadHistory();
            window.location.reload();
        }, 250);
    }

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        const message = event?.reason instanceof Error ? event.reason.message : String(event?.reason ?? '');
        if (isViteOptimizeDepError(message)) {
            log('warn', '[Dev] Matched optimize-deps unhandled rejection', {
                message,
                stack: event?.reason instanceof Error ? event.reason.stack : undefined,
                href: window.location?.href,
            });
            scheduleReload(message);
        }
    });
}
