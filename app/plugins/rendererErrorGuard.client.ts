import type { ComponentPublicInstance } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getIgnorableRuntimeErrorMessage } from '@app/utils/runtimeErrorFilter';

const RENDERER_GUARD_WARN_THROTTLE_MS = 5000;
const MAX_SERIALIZED_ERROR_LENGTH = 12_000;

interface IRendererErrorGuardState { cleanup: () => void; }

type TRendererErrorGuardWindow = Window & { __evbRendererErrorGuardState?: IRendererErrorGuardState };

function truncateSerializedError(value: string) {
    return value.length > MAX_SERIALIZED_ERROR_LENGTH
        ? `${value.slice(0, MAX_SERIALIZED_ERROR_LENGTH)}...`
        : value;
}

function readStringProperty(value: object, key: string) {
    const property = (value as Record<string, unknown>)[key];
    return typeof property === 'string' && property.trim().length > 0
        ? property
        : null;
}

function stringifyErrorValue(error: unknown) {
    if (error instanceof Error) {
        return [
            `${error.name}: ${error.message}`,
            error.stack,
        ].filter(Boolean).join('\n');
    }

    if (typeof error === 'string') {
        return error;
    }

    const seen = new WeakSet<object>();
    try {
        const serialized = JSON.stringify(error, (_key, value: unknown) => {
            if (value instanceof Error) {
                return {
                    name: value.name,
                    message: value.message,
                    stack: value.stack,
                };
            }

            if (typeof value === 'bigint') {
                return value.toString();
            }

            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular]';
                }
                seen.add(value);
            }

            return value;
        }, 2);
        return typeof serialized === 'string' ? serialized : String(error);
    } catch {
        return String(error);
    }
}

function serializeError(error: unknown) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }

    if (typeof error === 'object' && error !== null) {
        const message = readStringProperty(error, 'message') ?? stringifyErrorValue(error);
        const stack = readStringProperty(error, 'stack');
        return {
            message: truncateSerializedError(message),
            stack: stack ? truncateSerializedError(stack) : undefined,
            value: truncateSerializedError(stringifyErrorValue(error)),
        };
    }

    return {message: truncateSerializedError(stringifyErrorValue(error))};
}

function getTrimmedName(name: unknown) {
    return typeof name === 'string' && name.trim().length > 0
        ? name.trim()
        : null;
}

function getComponentTypeName(component: object) {
    const maybeNamed = component as {
        __name?: unknown;
        name?: unknown;
    };
    return getTrimmedName(maybeNamed.name) ?? getTrimmedName(maybeNamed.__name);
}

function getComponentName(instance: ComponentPublicInstance | null) {
    const component = instance?.$?.type;
    if (!component || typeof component !== 'object') {
        return null;
    }

    return getComponentTypeName(component);
}

export default defineNuxtPlugin((nuxtApp) => {
    if (typeof window === 'undefined') {
        return;
    }

    const { reportRuntimeError } = useRuntimeErrorReports();
    const windowWithState = window as TRendererErrorGuardWindow;
    if (windowWithState.__evbRendererErrorGuardState) {
        return;
    }

    const report = (message: string, details: Record<string, unknown>) => {
        BrowserLogger.error('renderer-guard', message, details);
        reportRuntimeError({
            title: message,
            source: 'renderer-guard',
            error: details,
        });
    };

    const previousHandler = nuxtApp.vueApp.config.errorHandler;
    const errorHandler = (error: unknown, instance: ComponentPublicInstance | null, info: string) => {
        report('Unhandled Vue error', {
            info,
            component: getComponentName(instance),
            error: serializeError(error),
        });

        if (typeof previousHandler === 'function') {
            previousHandler(error, instance, info);
        }
    };
    nuxtApp.vueApp.config.errorHandler = errorHandler;

    const onWindowError = (event: ErrorEvent) => {
        const ignorableMessage = getIgnorableRuntimeErrorMessage(event.error ?? event.message);
        if (ignorableMessage) {
            BrowserLogger.warnThrottled(
                'renderer-guard',
                ignorableMessage,
                RENDERER_GUARD_WARN_THROTTLE_MS,
                'Ignored benign window error',
                {
                    message: event.message,
                    filename: event.filename,
                    lineno: event.lineno,
                    colno: event.colno,
                    error: serializeError(event.error),
                },
            );
            return;
        }

        report('Unhandled window error', {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            error: serializeError(event.error),
        });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
        const ignorableMessage = getIgnorableRuntimeErrorMessage(event.reason);
        if (ignorableMessage) {
            BrowserLogger.warnThrottled(
                'renderer-guard',
                ignorableMessage,
                RENDERER_GUARD_WARN_THROTTLE_MS,
                'Ignored benign promise rejection',
                {reason: serializeError(event.reason)},
            );
            return;
        }

        report('Unhandled promise rejection in renderer', { reason: serializeError(event.reason) });
    };

    const originalUnmount = nuxtApp.vueApp.unmount.bind(nuxtApp.vueApp);
    let cleanedUp = false;
    function cleanup() {
        if (cleanedUp) {
            return;
        }

        cleanedUp = true;
        window.removeEventListener('error', onWindowError);
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
        if (nuxtApp.vueApp.config.errorHandler === errorHandler) {
            if (typeof previousHandler === 'function') {
                nuxtApp.vueApp.config.errorHandler = previousHandler;
            } else {
                delete nuxtApp.vueApp.config.errorHandler;
            }
        }
        if (nuxtApp.vueApp.unmount === guardedUnmount) {
            nuxtApp.vueApp.unmount = originalUnmount;
        }
        if (windowWithState.__evbRendererErrorGuardState?.cleanup === cleanup) {
            delete windowWithState.__evbRendererErrorGuardState;
        }
    }
    function guardedUnmount() {
        cleanup();
        originalUnmount();
    }

    windowWithState.__evbRendererErrorGuardState = {cleanup};
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    nuxtApp.vueApp.unmount = guardedUnmount;

    if (import.meta.hot) {
        import.meta.hot.dispose(cleanup);
    }
});
