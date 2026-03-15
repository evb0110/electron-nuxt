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

function getComponentName(instance: ComponentPublicInstance | null) {
    const component = instance?.$?.type;
    if (!component || typeof component !== 'object') {
        return null;
    }

    const maybeNamed = component as {
        __name?: unknown;
        name?: unknown;
    };
    if (typeof maybeNamed.name === 'string' && maybeNamed.name.trim().length > 0) {
        return maybeNamed.name.trim();
    }
    if (typeof maybeNamed.__name === 'string' && maybeNamed.__name.trim().length > 0) {
        return maybeNamed.__name.trim();
    }
    return null;
}

export default defineNuxtPlugin((nuxtApp) => {
    if (!import.meta.client) {
        return;
    }

    const { setFatalRuntimeError } = useFatalRuntimeError();
    const windowWithFlag = window as Window & {[INSTALL_FLAG]?: boolean};
    if (windowWithFlag[INSTALL_FLAG]) {
        return;
    }
    windowWithFlag[INSTALL_FLAG] = true;

    const report = (message: string, details: Record<string, unknown>) => {
        BrowserLogger.error('renderer-guard', message, details);
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
