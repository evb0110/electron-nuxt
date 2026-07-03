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
    markResolvedOnError?: (error: unknown) => boolean;
}

interface IPlatformHydratedLoadSuccess<T> {
    ok: true;
    value: T;
}

interface IPlatformHydratedLoadFailure {
    ok: false;
    error: unknown;
}

type TPlatformHydratedLoadResult<T> =
    | IPlatformHydratedLoadSuccess<T>
    | IPlatformHydratedLoadFailure;

interface IPlatformHydratedLoadRecord { promise: Promise<TPlatformHydratedLoadResult<unknown>> | null; }

const loadRecords = new Map<string, IPlatformHydratedLoadRecord>();

function getLoadRecord(key: string) {
    let record = loadRecords.get(key);
    if (!record) {
        record = { promise: null };
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
                const nextValue = await options.loadValue();
                state.value = nextValue;
                isResolved.value = true;
                return {
                    ok: true,
                    value: nextValue,
                } satisfies IPlatformHydratedLoadSuccess<T>;
            } catch (loadError) {
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
            options.onLoaded?.(result.value);
            clearRetryTimer();
            return result.value;
        }

        options.onError?.(result.error);
        const shouldRetry = options.shouldRetry?.(result.error) ?? false;
        if (!shouldRetry && (options.markResolvedOnError?.(result.error) ?? false)) {
            isResolved.value = true;
        }
        if (shouldRetry) {
            scheduleRetry();
        }
        return null;
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
        clearRetryTimer,
    };
};
