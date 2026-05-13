import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const isBrowserPlatformActiveMock = vi.fn();

vi.mock('@app/utils/platform', () => ({ isBrowserPlatformActive: isBrowserPlatformActiveMock }));

describe('platformShortcuts', () => {
    it('uses renderer menu accelerators only when native Electron accelerators are unavailable', async () => {
        const { shouldHandleRendererMenuAccelerators } = await import('@app/utils/platformShortcuts');

        isBrowserPlatformActiveMock.mockReturnValueOnce(false);
        expect(shouldHandleRendererMenuAccelerators()).toBe(false);

        isBrowserPlatformActiveMock.mockReturnValueOnce(true);
        expect(shouldHandleRendererMenuAccelerators()).toBe(true);
    });
});
