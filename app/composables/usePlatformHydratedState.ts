import { useTimeoutFn } from '@vueuse/core';
import { getErrorMessage } from '@app/utils/error';

interface IUsePlatformHydratedStateOptions<T> {
    key: string;
    initialValue: () => T;
    initialResolved: boolean;
    loadValue: () => Promise<T>;
    getErrorMessage?: (error: unknown) => string;
    onLoaded?: (value: T) => void;
    onError?: (error: unknown) => void;
    shouldRetry?: (error: unknown) => boolean;
    retryDelayMs?: number;
    maxAutomaticRetries?: number;
    markResolvedOnError?: (error: unknown) => boolean;
}

interface IPlatformHydratedLoadSuccess<T> {
    ok: true;
    value: T;
    supersededByLocalWrite: boolean;
}

interface IPlatformHydratedLoadFailure {
    ok: false;
    error: unknown;
}

type TPlatformHydratedLoadResult<T> =
    | IPlatformHydratedLoadSuccess<T>
    | IPlatformHydratedLoadFailure;

interface IPlatformHydratedLoadRecord {
    promise: Promise<TPlatformHydratedLoadResult<unknown>> | null;
    consecutiveFailures: number;
}

const loadRecords = new Map<string, IPlatformHydratedLoadRecord>();

function getLoadRecord(key: string) {
    let record = loadRecords.get(key);
    if (!record) {
        record = {
            promise: null,
            consecutiveFailures: 0,
        };
        loadRecords.set(key, record);
    }
    return record;
}

export const usePlatformHydratedState = <T>(
    options: IUsePlatformHydratedStateOptions<T>,
) => {
    const state = useState<T>(`${options.key}:data`, options.initialValue);
    const isLoading = useState(`${options.key}:is-loading`, () => false);
    const isResolved = useState(`${options.key}:is-resolved`, () => options.initialResolved);
    const error = useState<string | null>(`${options.key}:error`, () => null);
    const loadRecord = getLoadRecord(options.key);
    let isDisposed = false;
    const retry = useTimeoutFn(() => {
        if (isDisposed) {
            return;
        }
        void load();
    }, () => options.retryDelayMs ?? 0, { immediate: false });

    function clearRetryTimer() {
        retry.stop();
    }

    function scheduleRetry() {
        if (
            isDisposed
            || retry.isPending.value
            || typeof options.retryDelayMs !== 'number'
            || options.retryDelayMs <= 0
        ) {
            return;
        }

        retry.start();
    }

    function startSharedLoad() {
        if (loadRecord.promise) {
            return loadRecord.promise as Promise<TPlatformHydratedLoadResult<T>>;
        }
        const nextPromise = (async () => {
            isLoading.value = true;
            error.value = null;

            try {
                const stateAtLoadStart = state.value;
                const nextValue = await options.loadValue();
                const supersededByLocalWrite = state.value !== stateAtLoadStart;
                if (!supersededByLocalWrite) {
                    state.value = nextValue;
                }
                loadRecord.consecutiveFailures = 0;
                isResolved.value = true;
                return {
                    ok: true,
                    value: nextValue,
                    supersededByLocalWrite,
                } satisfies IPlatformHydratedLoadSuccess<T>;
            } catch (loadError) {
                loadRecord.consecutiveFailures += 1;
                error.value = options.getErrorMessage?.(loadError)
                    ?? getErrorMessage(loadError);
                if (options.markResolvedOnError?.(loadError) ?? false) {
                    isResolved.value = true;
                }
                return {
                    ok: false,
                    error: loadError,
                } satisfies IPlatformHydratedLoadFailure;
            } finally {
                isLoading.value = false;
                loadRecord.promise = null;
            }
        })();

        loadRecord.promise = nextPromise;
        return nextPromise;
    }

    async function load() {
        if (isDisposed) {
            return null;
        }

        const result = await startSharedLoad();
        if (isDisposed) {
            return null;
        }

        if (result.ok) {
            if (!result.supersededByLocalWrite) {
                options.onLoaded?.(result.value);
            }
            clearRetryTimer();
            return result.value;
        }

        options.onError?.(result.error);
        const wantsRetry = options.shouldRetry?.(result.error) ?? false;
        const maxAutomaticRetries = options.maxAutomaticRetries;
        const automaticRetriesExhausted = wantsRetry
            && typeof maxAutomaticRetries === 'number'
            && loadRecord.consecutiveFailures > Math.max(0, Math.floor(maxAutomaticRetries));
        const shouldRetry = wantsRetry && !automaticRetriesExhausted;
        if (
            !shouldRetry
            && (
                automaticRetriesExhausted
                || (options.markResolvedOnError?.(result.error) ?? false)
            )
        ) {
            isResolved.value = true;
        }
        if (shouldRetry) {
            scheduleRetry();
        }
        return null;
    }

    async function retryNow() {
        if (isDisposed) {
            return null;
        }
        clearRetryTimer();
        if (!loadRecord.promise) {
            loadRecord.consecutiveFailures = 0;
            isResolved.value = false;
        }
        return load();
    }

    if (getCurrentScope()) {
        onScopeDispose(() => {
            isDisposed = true;
            clearRetryTimer();
        });
    }

    return {
        state,
        isLoading,
        isResolved,
        error,
        load,
        retryNow,
        clearRetryTimer,
    };
};
