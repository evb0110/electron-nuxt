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
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const instanceTokens = new Map<string, number>();
let nextInstanceToken = 1;

export const usePlatformHydratedState = <T>(
    options: IUsePlatformHydratedStateOptions<T>,
) => {
    const instanceToken = nextInstanceToken;
    nextInstanceToken += 1;
    instanceTokens.set(options.key, instanceToken);
    const state = useState<T>(`${options.key}:data`, options.initialValue);
    const isLoading = useState(`${options.key}:is-loading`, () => false);
    const isResolved = useState(`${options.key}:is-resolved`, () => options.initialResolved);
    const error = useState<string | null>(`${options.key}:error`, () => null);

    function clearRetryTimer() {
        const existingTimer = retryTimers.get(options.key);
        if (!existingTimer) {
            return;
        }

        clearTimeout(existingTimer);
        retryTimers.delete(options.key);
    }

    function isCurrentInstance() {
        return instanceTokens.get(options.key) === instanceToken;
    }

    function scheduleRetry() {
        if (
            retryTimers.has(options.key)
            || typeof options.retryDelayMs !== 'number'
            || options.retryDelayMs <= 0
        ) {
            return;
        }

        const timer = setTimeout(() => {
            retryTimers.delete(options.key);
            if (!isCurrentInstance()) {
                return;
            }
            void load();
        }, options.retryDelayMs);
        retryTimers.set(options.key, timer);
    }

    async function load() {
        const existingPromise = loadPromises.get(options.key) as Promise<T | null> | undefined;
        if (existingPromise) {
            return existingPromise;
        }

        const nextPromise = (async () => {
            isLoading.value = true;
            error.value = null;
            let shouldRetry = false;

            try {
                const nextValue = await options.loadValue();
                if (!isCurrentInstance()) {
                    return null;
                }
                state.value = nextValue;
                options.onLoaded?.(nextValue);
                isResolved.value = true;
                clearRetryTimer();
                return nextValue;
            } catch (loadError) {
                if (!isCurrentInstance()) {
                    return null;
                }
                error.value = options.getErrorMessage?.(loadError)
                    ?? getErrorMessage(loadError);
                options.onError?.(loadError);
                shouldRetry = options.shouldRetry?.(loadError) ?? false;
                if (!shouldRetry && (options.markResolvedOnError?.(loadError) ?? false)) {
                    isResolved.value = true;
                }
                return null;
            } finally {
                if (isCurrentInstance()) {
                    isLoading.value = false;
                }
                loadPromises.delete(options.key);
                if (shouldRetry && isCurrentInstance()) {
                    scheduleRetry();
                }
            }
        })();

        loadPromises.set(options.key, nextPromise);
        return nextPromise;
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
