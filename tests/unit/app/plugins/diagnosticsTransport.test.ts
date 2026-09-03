import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    createTransport: vi.fn(),
    hasElectronAPI: vi.fn(),
    initializeReporter: vi.fn(),
}));

vi.mock('@app/utils/failureReporter', () => ({initializeRendererFailureReporter: mocks.initializeReporter}));
vi.mock('@app/utils/platform', () => ({hasElectronAPI: mocks.hasElectronAPI}));
vi.mock('@app/utils/browserDiagnosticsTransport', () => ({createConfiguredBrowserDiagnosticsTransport: mocks.createTransport}));

async function loadPlugin() {
    return (await import('@app/plugins/diagnosticsTransport.client')).default as () => void;
}

describe('hosted diagnostics transport plugin', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('defineNuxtPlugin', (plugin: unknown) => plugin);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('does not initialize a hosted transport inside Electron', async () => {
        mocks.hasElectronAPI.mockReturnValue(true);
        const plugin = await loadPlugin();

        plugin();

        expect(mocks.initializeReporter).not.toHaveBeenCalled();
    });

    it('defers browser transport loading until the reporter admits it', async () => {
        const transport = {capture: vi.fn()};
        mocks.hasElectronAPI.mockReturnValue(false);
        mocks.createTransport.mockReturnValue(transport);
        const plugin = await loadPlugin();

        plugin();

        expect(mocks.initializeReporter).toHaveBeenCalledWith({
            host: 'hosted-browser',
            loadHostedTransport: expect.any(Function),
        });
        expect(mocks.createTransport).not.toHaveBeenCalled();

        const options = mocks.initializeReporter.mock.calls[0]?.[0] as {loadHostedTransport: () => Promise<unknown>;};
        await expect(options.loadHostedTransport()).resolves.toBe(transport);
        expect(mocks.createTransport).toHaveBeenCalledOnce();
    });
});
