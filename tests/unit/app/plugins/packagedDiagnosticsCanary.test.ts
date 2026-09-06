import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    captureForPresentation: vi.fn(),
    discardPendingDiagnostics: vi.fn(),
    emitObservedConsoleErrorForCanary: vi.fn(),
    getPreference: vi.fn(),
    initializeReporter: vi.fn(),
    reportRuntimeError: vi.fn(),
    resendPendingDiagnosticOnce: vi.fn(),
    save: vi.fn(),
    setFatalRuntimeError: vi.fn(),
    updateSetting: vi.fn(),
}));

vi.mock('@app/utils/failureReporter', () => ({initializeRendererFailureReporter: mocks.initializeReporter}));
vi.mock('@app/utils/consoleErrorObserver', () => ({emitObservedConsoleErrorForCanary: mocks.emitObservedConsoleErrorForCanary}));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({
    discardPendingDiagnostics: mocks.discardPendingDiagnostics,
    reportRuntimeError: mocks.reportRuntimeError,
    resendPendingDiagnosticOnce: mocks.resendPendingDiagnosticOnce,
})}));
vi.mock('@app/composables/useFatalRuntimeError', () => ({useFatalRuntimeError: () => ({setFatalRuntimeError: mocks.setFatalRuntimeError})}));
vi.mock('@app/composables/useSettings', () => ({useSettings: () => ({
    isLoaded: {value: true},
    save: mocks.save,
    settings: {value: {clientDiagnosticsPreference: 'unknown'}},
    updateSetting: mocks.updateSetting,
})}));

async function loadPlugin() {
    return (await import('@app/plugins/packagedDiagnosticsCanary.client')).default as () => void;
}

describe('packaged diagnostics canary plugin', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
        vi.stubGlobal('useRuntimeErrorReports', () => ({
            discardPendingDiagnostics: mocks.discardPendingDiagnostics,
            reportRuntimeError: mocks.reportRuntimeError,
            resendPendingDiagnosticOnce: mocks.resendPendingDiagnosticOnce,
        }));
        vi.stubGlobal('useFatalRuntimeError', () => ({setFatalRuntimeError: mocks.setFatalRuntimeError}));
        vi.stubGlobal('useSettings', () => ({
            isLoaded: {value: true},
            save: mocks.save,
            settings: {value: {clientDiagnosticsPreference: 'unknown'}},
            updateSetting: mocks.updateSetting,
        }));
        mocks.initializeReporter.mockReturnValue({
            captureForPresentation: mocks.captureForPresentation,
            getPreference: mocks.getPreference,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('stays dormant outside an automation-enabled packaged renderer', async () => {
        vi.stubGlobal('window', {});
        const plugin = await loadPlugin();

        plugin();

        expect(mocks.initializeReporter).not.toHaveBeenCalled();
    });

    it('installs the automation API and forwards its direct-console canary', async () => {
        const addEventListener = vi.fn();
        const canaryWindow = {
            __evbDiagnosticsCanaryMain: {trigger: vi.fn()},
            addEventListener,
        };
        vi.stubGlobal('window', canaryWindow);
        const plugin = await loadPlugin();

        plugin();
        (canaryWindow as typeof canaryWindow & {__evbRendererDiagnosticsCanary: {directConsoleError(): void;};}).__evbRendererDiagnosticsCanary.directConsoleError();

        expect(mocks.initializeReporter).toHaveBeenCalledWith({host: 'electron'});
        expect(mocks.emitObservedConsoleErrorForCanary).toHaveBeenCalledOnce();
        expect(addEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function), {once: true});
    });
});
