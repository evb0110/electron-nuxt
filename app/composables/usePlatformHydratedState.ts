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

const loadPromises = new Map<string, Promise<unknown>>();

export const usePlatformHydratedState = <T>(
    options: IUsePlatformHydratedStateOptions<T>,
) => {
    const state = useState<T>(`${options.key}:data`, options.initialValue);
    const isLoading = useState(`${options.key}:is-loading`, () => false);
    const isResolved = useState(`${options.key}:is-resolved`, () => options.initialResolved);
    const error = useState<string | null>(`${options.key}:error`, () => null);
    let isDisposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function clearRetryTimer() {
        if (!retryTimer) {
            return;
        }

        clearTimeout(retryTimer);
        retryTimer = null;
    }

    function scheduleRetry() {
        if (
            isDisposed
            || retryTimer
            || typeof options.retryDelayMs !== 'number'
            || options.retryDelayMs <= 0
        ) {
            return;
        }

        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (isDisposed) {
                return;
            }
            void load();
        }, options.retryDelayMs);
    }

    async function load() {
        const existingPromise = loadPromises.get(options.key) as Promise<T | null> | undefined;
        if (existingPromise) {
            return existingPromise;
        }
        if (isDisposed) {
            return null;
        }

        const nextPromise = (async () => {
            isLoading.value = true;
            error.value = null;
            let shouldRetry = false;

            try {
                const nextValue = await options.loadValue();
                state.value = nextValue;
                options.onLoaded?.(nextValue);
                isResolved.value = true;
                clearRetryTimer();
                return nextValue;
            } catch (loadError) {
                error.value = options.getErrorMessage?.(loadError)
                    ?? getErrorMessage(loadError);
                options.onError?.(loadError);
                shouldRetry = options.shouldRetry?.(loadError) ?? false;
                if (!shouldRetry && (options.markResolvedOnError?.(loadError) ?? false)) {
                    isResolved.value = true;
                }
                return null;
            } finally {
                isLoading.value = false;
                loadPromises.delete(options.key);
                if (shouldRetry) {
                    scheduleRetry();
                }
            }
        })();

        loadPromises.set(options.key, nextPromise);
        return nextPromise;
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
