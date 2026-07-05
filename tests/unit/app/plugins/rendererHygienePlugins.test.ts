import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    reportRuntimeError: vi.fn(),
    onDebugLog: vi.fn(),
}));

vi.mock('@app/utils/getSettingsCapability', () => ({getSettingsCapability: () => ({onDebugLog: mocks.onDebugLog})}));

vi.mock('@app/composables/useRuntimeErrorReports', () => (
    {useRuntimeErrorReports: () => ({reportRuntimeError: mocks.reportRuntimeError})}
));

const browserLoggerMock = {
    error: vi.fn(),
    warnThrottled: vi.fn(),
};

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: browserLoggerMock}));

function installAutoImportStubs() {
    vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
    vi.stubGlobal('useRuntimeErrorReports', () => ({reportRuntimeError: mocks.reportRuntimeError}));
    vi.stubGlobal('useCookie', () => ({value: 'en'}));
}

function createNuxtApp() {
    const hooks = new Map<string, () => void>();
    const originalUnmount = vi.fn();
    const previousErrorHandler = vi.fn();
    return {
        hooks,
        originalUnmount,
        previousErrorHandler,
        nuxtApp: {
            hook: vi.fn((name: string, callback: () => void) => {
                hooks.set(name, callback);
            }),
            vueApp: {
                config: {errorHandler: previousErrorHandler},
                unmount: originalUnmount,
            },
        },
    };
}

describe('renderer hygiene plugins', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        installAutoImportStubs();
        vi.stubGlobal('window', new EventTarget());
    });

    it('unsubscribes the runtime error log stream on app unmount and guards duplicate installs', async () => {
        const unsubscribe = vi.fn();
        mocks.onDebugLog.mockReturnValue(unsubscribe);
        const plugin = (await import('@app/plugins/runtimeErrorLogStream.client')).default as (app: unknown) => void;
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        plugin(harness.nuxtApp);
        harness.hooks.get('app:mounted')?.();
        harness.hooks.get('app:mounted')?.();
        harness.nuxtApp.vueApp.unmount();

        expect(mocks.onDebugLog).toHaveBeenCalledTimes(1);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(harness.originalUnmount).toHaveBeenCalledTimes(1);
    });

    it('removes renderer guard listeners and restores the previous Vue error handler on unmount', async () => {
        const windowTarget = new EventTarget();
        const addEventListenerSpy = vi.spyOn(windowTarget, 'addEventListener');
        const removeEventListenerSpy = vi.spyOn(windowTarget, 'removeEventListener');
        vi.stubGlobal('window', windowTarget);
        const plugin = (await import('@app/plugins/rendererErrorGuard.client')).default as (app: unknown) => void;
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        const installedErrorHandler = harness.nuxtApp.vueApp.config.errorHandler;
        plugin(harness.nuxtApp);
        harness.nuxtApp.vueApp.unmount();

        expect(addEventListenerSpy).toHaveBeenCalledTimes(2);
        expect(removeEventListenerSpy).toHaveBeenCalledWith('error', expect.any(Function));
        expect(removeEventListenerSpy).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));
        expect(harness.nuxtApp.vueApp.config.errorHandler).toBe(harness.previousErrorHandler);
        expect(installedErrorHandler).not.toBe(harness.previousErrorHandler);
        expect(harness.originalUnmount).toHaveBeenCalledTimes(1);
    });
});
