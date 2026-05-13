import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const getPlatformApiMock = vi.fn();

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => getPlatformApiMock() }));

describe('platformWindowTabs', () => {
    it('returns the shared window tabs capability from the platform api', async () => {
        const windowTabsCapability = { notifyRendererReady: vi.fn() };
        getPlatformApiMock.mockReturnValueOnce({ windowTabs: windowTabsCapability });

        const { getWindowTabsCapability } = await import('@app/utils/platformWindowTabs');

        expect(getWindowTabsCapability()).toBe(windowTabsCapability);
    });
});
