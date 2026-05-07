import type { ComponentPublicInstance } from 'vue';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getIgnorableRuntimeErrorMessage } from '@app/utils/runtime-error-filter';

const INSTALL_FLAG = '__evbRendererErrorGuardInstalled';

function serializeError(error: unknown) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }
    return error;
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
    if (!import.meta.client) {
        return;
    }

    const { setFatalRuntimeError } = useFatalRuntimeError();
    const { reportRuntimeError } = useRuntimeErrorReports();
    const windowWithFlag = window as Window & {[INSTALL_FLAG]?: boolean};
    if (windowWithFlag[INSTALL_FLAG]) {
        return;
    }
    windowWithFlag[INSTALL_FLAG] = true;

    const report = (message: string, details: Record<string, unknown>) => {
        BrowserLogger.error('renderer-guard', message, details);
        reportRuntimeError({
            title: message,
            source: 'renderer-guard',
            error: details,
        });
    };

    const previousHandler = nuxtApp.vueApp.config.errorHandler;
    nuxtApp.vueApp.config.errorHandler = (error, instance, info) => {
        report('Unhandled Vue error', {
            info,
            component: getComponentName(instance),
            error: serializeError(error),
        });
        setFatalRuntimeError('runtime', error, `vue:${info}`);

        if (typeof previousHandler === 'function') {
            previousHandler(error, instance, info);
        }
    };

    window.addEventListener('error', (event) => {
        const ignorableMessage = getIgnorableRuntimeErrorMessage(event.error ?? event.message);
        if (ignorableMessage) {
            BrowserLogger.warnThrottled(
                'renderer-guard',
                ignorableMessage,
                5000,
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
        setFatalRuntimeError('runtime', event.error ?? event.message, 'window:error');
    });

    window.addEventListener('unhandledrejection', (event) => {
        const ignorableMessage = getIgnorableRuntimeErrorMessage(event.reason);
        if (ignorableMessage) {
            BrowserLogger.warnThrottled(
                'renderer-guard',
                ignorableMessage,
                5000,
                'Ignored benign promise rejection',
                {reason: serializeError(event.reason)},
            );
            return;
        }

        report('Unhandled promise rejection in renderer', { reason: serializeError(event.reason) });
        setFatalRuntimeError('runtime', event.reason, 'window:unhandledrejection');
    });
});
