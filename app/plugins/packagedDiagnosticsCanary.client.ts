import {initializeRendererFailureReporter} from '@app/utils/failureReporter';
import {emitObservedConsoleErrorForCanary} from '@app/utils/consoleErrorObserver';
import type {TClientDiagnosticsPreference} from '@contracts/diagnostics/diagnosticsPreference';

export default defineNuxtPlugin(() => {
    if (typeof window === 'undefined' || !window.__evbDiagnosticsCanaryMain) {
        return;
    }

    const reporter = initializeRendererFailureReporter({host: 'electron'});
    const {
        discardPendingDiagnostics,
        reportRuntimeError,
        resendPendingDiagnosticOnce,
    } = useRuntimeErrorReports();
    const {setFatalRuntimeError} = useFatalRuntimeError();
    const {
        isLoaded,
        save,
        settings,
        updateSetting,
    } = useSettings();

    function createPresentation(kind: 'fatal-ui' | 'renderer' | 'ui-only' | 'worker-parent') {
        if (kind === 'renderer') {
            return reporter.captureForPresentation({
                code: 'RENDERER_ERROR_GUARD_FAILED',
                context: {source: 'window'},
                local: {
                    source: 'diagnostics-canary',
                    message: 'Packaged renderer diagnostics canary',
                },
            });
        }

        if (kind === 'worker-parent') {
            return reporter.captureForPresentation({
                code: 'RENDERER_SEARCH_WORKER_FAILED',
                context: {},
                local: {
                    source: 'diagnostics-canary',
                    message: 'Packaged worker-parent diagnostics canary',
                },
            }, {runtime: 'browser-worker-parent'});
        }
        if (kind === 'ui-only') {
            return reporter.captureForPresentation({
                code: 'RENDERER_RUNTIME_ERROR_LOG_STREAM_FAILED',
                context: {phase: 'legacy-error-projection'},
                local: {
                    source: 'diagnostics-canary',
                    message: 'Packaged UI-only diagnostics canary',
                },
            });
        }
        return reporter.captureForPresentation({
            code: 'RENDERER_STARTUP_WARMUP_FAILED',
            context: {},
            local: {
                source: 'diagnostics-canary',
                message: 'Packaged fatal UI diagnostics canary',
            },
        });
    }

    window.__evbRendererDiagnosticsCanary = {
        capture(kind) {
            const presentation = createPresentation(kind);
            if (kind === 'fatal-ui') {
                const fatalPresentation = {
                    ...presentation,
                    title: 'Packaged diagnostics canary',
                    description: 'Fatal UI diagnostics canary',
                };
                setFatalRuntimeError('runtime', fatalPresentation);
            } else {
                const runtimePresentation = {
                    ...presentation,
                    title: 'Packaged diagnostics canary',
                    description: `${kind} diagnostics canary`,
                };
                reportRuntimeError(runtimePresentation);
            }
            return presentation.failure;
        },
        directConsoleError() {
            emitObservedConsoleErrorForCanary();
        },
        getPreference: () => reporter.getPreference(),
        async setPreference(preference: TClientDiagnosticsPreference) {
            if (!isLoaded.value) {
                return false;
            }
            updateSetting('clientDiagnosticsPreference', preference);
            if (preference !== 'granted') {
                discardPendingDiagnostics();
            }
            const saved = await save();
            if (saved && preference === 'granted') {
                resendPendingDiagnosticOnce();
            }
            return saved && settings.value.clientDiagnosticsPreference === preference;
        },
    };

    const cleanup = () => {
        delete window.__evbRendererDiagnosticsCanary;
    };
    window.addEventListener('pagehide', cleanup, {once: true});
    if (import.meta.hot) {
        import.meta.hot.dispose(cleanup);
    }
});
