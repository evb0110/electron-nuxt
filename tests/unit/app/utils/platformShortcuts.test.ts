import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const hasElectronApiMock = vi.fn();

vi.mock('@app/utils/platform', () => ({ hasElectronAPI: hasElectronApiMock }));

describe('platform-shortcuts', () => {
    it('uses renderer menu accelerators only when native Electron accelerators are unavailable', async () => {
        const { shouldHandleRendererMenuAccelerators } = await import('@app/utils/platform-shortcuts');

        hasElectronApiMock.mockReturnValueOnce(true);
        expect(shouldHandleRendererMenuAccelerators()).toBe(false);

        hasElectronApiMock.mockReturnValueOnce(false);
        expect(shouldHandleRendererMenuAccelerators()).toBe(true);
    });
});
