import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    browserLoggerError: vi.fn(),
    onStatus: vi.fn(),
}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    error: mocks.browserLoggerError,
}}));

vi.mock('@app/platform/browserPlatformApi', () => ({browserPlatformApi: {updates: {onStatus: mocks.onStatus}}}));

describe('lazyBrowserPlatformApi', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
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
