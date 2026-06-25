import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    browserLoggerError: vi.fn(),
    browserPlatformImportCount: 0,
    onStatus: vi.fn(),
}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: mocks.browserLoggerError,
}}));

vi.mock('@app/platform/browserPlatformApi', () => {
    mocks.browserPlatformImportCount += 1;
    return {browserPlatformApi: {updates: {onStatus: mocks.onStatus}}};
});

describe('lazyBrowserPlatformApi', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.browserPlatformImportCount = 0;
    });

    it('does not load the browser platform module until a forwarded lazy method is used', async () => {
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        expect(mocks.browserPlatformImportCount).toBe(0);

        const unsubscribe = lazyBrowserPlatformApi.updates.onStatus(vi.fn());

        await vi.waitFor(() => {
            expect(mocks.browserPlatformImportCount).toBe(1);
        });
        unsubscribe();
    });

    it('keeps direct browser-only members synchronous without loading the browser platform module', async () => {
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        const firstFile = new File([new Uint8Array([1])], 'first.pdf', { type: 'application/pdf' });
        const secondFile = new File([new Uint8Array([2])], 'second.pdf', { type: 'application/pdf' });
        const firstRef = lazyBrowserPlatformApi.documents.getPathForFile(firstFile);
        const refs = lazyBrowserPlatformApi.documents.getPathsForFiles([
            firstFile,
            secondFile,
        ]);

        expect(firstRef).toMatch(/^browser:\/\/documents\//u);
        expect(refs[0]).toBe(firstRef);
        expect(refs[1]).toMatch(/^browser:\/\/documents\//u);
        expect(lazyBrowserPlatformApi.system.getMemoryInfo()).toBeNull();
        expect(mocks.browserPlatformImportCount).toBe(0);
    });

    it('reports lazy event subscription failures with the capability path', async () => {
        const subscriptionError = new Error('subscription failed');
        mocks.onStatus.mockImplementation(() => {
            throw subscriptionError;
        });
        const { lazyBrowserPlatformApi } = await import('@app/platform/lazyBrowserPlatformApi');

        const unsubscribe = lazyBrowserPlatformApi.updates.onStatus(vi.fn());

        await vi.waitFor(() => {
            expect(mocks.browserLoggerError).toHaveBeenCalledWith(
                'platform',
                'Failed to subscribe to browser event updates.onStatus',
                subscriptionError,
            );
        });
        unsubscribe();
    });
});
