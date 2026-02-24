import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    resolveAllowedReadPath: vi.fn(),
    findWorkingCopyPathByOriginalPath: vi.fn(),
}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        on: vi.fn(),
    },
    ipcMain: {handle: vi.fn()},
    webContents: {fromId: vi.fn(() => null)},
}));

vi.mock('@electron/utils/path-validator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));

vi.mock('@electron/ipc/workingCopy', () => ({findWorkingCopyPathByOriginalPath: mocks.findWorkingCopyPathByOriginalPath}));

describe('resolveSearchablePdfPath', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns directly resolved temp path when available', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValueOnce('/tmp/pdf-work-1/work.pdf');

        const { resolveSearchablePdfPath } = await import('@electron/search/ipc');
        const resolved = await resolveSearchablePdfPath('/tmp/pdf-work-1/work.pdf');

        expect(resolved).toBe('/tmp/pdf-work-1/work.pdf');
        expect(mocks.findWorkingCopyPathByOriginalPath).not.toHaveBeenCalled();
    });

    it('falls back to mapped working copy path for original-path requests', async () => {
        mocks.resolveAllowedReadPath
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('/tmp/pdf-work-2/working.pdf');
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue('/tmp/pdf-work-2/working.pdf');

        const { resolveSearchablePdfPath } = await import('@electron/search/ipc');
        const resolved = await resolveSearchablePdfPath('/Users/test/Documents/original.pdf');

        expect(resolved).toBe('/tmp/pdf-work-2/working.pdf');
        expect(mocks.findWorkingCopyPathByOriginalPath)
            .toHaveBeenCalledWith('/Users/test/Documents/original.pdf');
    });

    it('returns null when neither direct nor mapped paths are allowed', async () => {
        mocks.resolveAllowedReadPath.mockResolvedValue(null);
        mocks.findWorkingCopyPathByOriginalPath.mockReturnValue(null);

        const { resolveSearchablePdfPath } = await import('@electron/search/ipc');
        const resolved = await resolveSearchablePdfPath('/Users/test/Documents/original.pdf');

        expect(resolved).toBeNull();
    });
});
