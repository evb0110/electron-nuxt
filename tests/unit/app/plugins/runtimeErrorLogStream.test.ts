import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IDebugLogEntry} from '@contracts/electronApiCommon';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

const mocks = vi.hoisted(() => ({
    reportRuntimeError: vi.fn(),
    onDebugLog: vi.fn(),
    capture: vi.fn(),
    initializeRendererFailureReporter: vi.fn(),
    getValidatedElectronPlatformApi: vi.fn((): unknown => undefined),
    waitForPreferredDesktopPlatformBridge: vi.fn(async () => ({
        bridgeReady: false,
        shouldWait: false,
    })),
    isElectronUserAgent: vi.fn(() => true),
}));

vi.mock('@app/utils/getSettingsCapability', () => ({getSettingsCapability: () => ({onDebugLog: mocks.onDebugLog})}));
vi.mock('@app/utils/platform', () => ({
    isElectronUserAgent: mocks.isElectronUserAgent,
    waitForPreferredDesktopPlatformBridge: mocks.waitForPreferredDesktopPlatformBridge,
}));
vi.mock('@app/utils/electronPlatformBridge', () => ({getValidatedElectronPlatformApi: mocks.getValidatedElectronPlatformApi}));
vi.mock('@app/utils/failureReporter', () => ({initializeRendererFailureReporter: mocks.initializeRendererFailureReporter}));
vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: mocks.reportRuntimeError})}));
vi.mock('@app/utils/createPluginTranslate', () => ({createPluginTranslate: () => (key: string) => key}));
vi.mock('@i18n-core', () => ({isLocaleMessageSource: () => false}));

const failure: FailureReceipt = {
    eventId: 'd'.repeat(32) as FailureReceipt['eventId'],
    code: 'UNCLASSIFIED_RENDERER_ERROR',
    occurredAt: 1_757_000_000_000,
    severity: 'error',
};

function installAutoImportStubs() {
    vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
    vi.stubGlobal('useRuntimeErrorReports', () => ({reportRuntimeError: mocks.reportRuntimeError}));
    vi.stubGlobal('useCookie', () => ({value: 'en'}));
}

function createNuxtApp() {
    const hooks = new Map<string, () => void>();
    const originalUnmount = vi.fn();
    return {
        hooks,
        nuxtApp: {
            hook: vi.fn((name: string, callback: () => void) => {
                hooks.set(name, callback);
            }),
            vueApp: {unmount: originalUnmount},
        },
    };
}

async function flushPluginTasks() {
    await Promise.resolve();
    await Promise.resolve();
}

async function loadPlugin() {
    return (await import('@app/plugins/runtimeErrorLogStream.client')).default as (app: unknown) => void;
}

describe('runtime error log stream', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
        installAutoImportStubs();
        vi.stubGlobal('window', new EventTarget());
        Object.defineProperty(window, 'location', {
            configurable: true,
            value: {pathname: '/electron'},
        });
        Object.defineProperty(window, 'electronAPI', {
            configurable: true,
            value: {diagnostics: {onDebugLog: mocks.onDebugLog}},
        });
        mocks.getValidatedElectronPlatformApi.mockReturnValue({diagnostics: {onDebugLog: mocks.onDebugLog}} as never);
        mocks.initializeRendererFailureReporter.mockReturnValue({capture: mocks.capture});
        mocks.capture.mockReturnValue(failure);
    });

    it('presents a main-owned failure receipt without recapturing it', async () => {
        const unsubscribe = vi.fn();
        mocks.onDebugLog.mockReturnValue(unsubscribe);
        const plugin = await loadPlugin();
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        harness.hooks.get('app:mounted')?.();
        await flushPluginTasks();

        const callback = mocks.onDebugLog.mock.calls[0]?.[0] as (entry: IDebugLogEntry) => void;
        callback({
            source: 'main',
            message: '[ERROR] main failure',
            timestamp: '2026-09-03T00:00:00.000Z',
            level: 'ERROR',
            failureRef: {
                eventId: 'a'.repeat(32) as FailureReceipt['eventId'],
                code: 'UNCLASSIFIED_MAIN_ERROR',
                severity: 'fatal',
            },
        });

        expect(mocks.capture).not.toHaveBeenCalled();
        expect(mocks.reportRuntimeError).toHaveBeenCalledWith(expect.objectContaining({
            failure: {
                eventId: 'a'.repeat(32),
                code: 'UNCLASSIFIED_MAIN_ERROR',
                occurredAt: Date.parse('2026-09-03T00:00:00.000Z'),
                severity: 'fatal',
            },
            description: expect.stringContaining(`Error ID: ${'a'.repeat(32)}`),
        }));

        harness.nuxtApp.vueApp.unmount();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('owns one renderer occurrence for a bridge-init defect and keeps arbitrary error text out of capture input', async () => {
        mocks.onDebugLog.mockImplementation(() => {
            throw new Error('private bridge failure details');
        });
        const plugin = await loadPlugin();
        const harness = createNuxtApp();

        plugin(harness.nuxtApp);
        harness.hooks.get('app:mounted')?.();
        await flushPluginTasks();

        expect(mocks.initializeRendererFailureReporter).toHaveBeenCalledWith({host: 'electron'});
        expect(mocks.capture).toHaveBeenCalledOnce();
        const [captureInput] = mocks.capture.mock.calls[0] as [{local: {message: string}}];
        expect(captureInput.local.message).toBe('Electron diagnostics log stream initialization failed');
        expect(JSON.stringify(captureInput)).not.toContain('private bridge failure details');
        expect(mocks.reportRuntimeError).toHaveBeenCalledWith({
            failure,
            title: 'errors.runtime.streamError',
        });
    });
});
