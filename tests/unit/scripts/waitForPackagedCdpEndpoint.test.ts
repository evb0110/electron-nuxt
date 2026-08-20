import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {waitForPackagedCdpEndpoint} from '@scripts/release/waitForPackagedCdpEndpoint';

describe('waitForPackagedCdpEndpoint', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the debugger endpoint from a ready packaged application', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/test'}),
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(waitForPackagedCdpEndpoint(9_222, 1_000, 'Packaged test app'))
            .resolves.toBe('ws://127.0.0.1/devtools/browser/test');
        expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9222/json/version');
    });

    it('reports the owning application when the deadline is already exhausted', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        await expect(waitForPackagedCdpEndpoint(9_223, 0, 'Packaged test app'))
            .rejects.toThrow('Packaged test app did not expose CDP on port 9223');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
