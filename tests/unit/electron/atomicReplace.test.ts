import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    close: vi.fn(),
    open: vi.fn(),
    rename: vi.fn(),
    sync: vi.fn(),
    unlink: vi.fn(),
}));

const originalPlatform = process.platform;

vi.mock('node:crypto', () => ({ randomBytes: () => Buffer.from('fixed-id') }));

vi.mock('fs/promises', () => ({
    open: (...args: unknown[]) => mocks.open(...args),
    rename: (...args: unknown[]) => mocks.rename(...args),
    unlink: (...args: unknown[]) => mocks.unlink(...args),
}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
})}));

function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: platform,
    });
}

describe('atomicReplace', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.close.mockResolvedValue(undefined);
        mocks.open.mockResolvedValue({
            close: mocks.close,
            sync: mocks.sync,
        });
        mocks.rename.mockResolvedValue(undefined);
        mocks.unlink.mockResolvedValue(undefined);
        mocks.sync.mockResolvedValue(undefined);
    });

    afterEach(() => {
        setPlatform(originalPlatform);
    });

    it('continues replacing output when Windows refuses to fsync the temp file', async () => {
        setPlatform('win32');
        const fsyncError = Object.assign(new Error('operation not permitted, fsync'), { code: 'EPERM' });
        mocks.sync.mockRejectedValueOnce(fsyncError);

        const { atomicReplace } = await import('@electron/utils/atomic-replace');

        await expect(atomicReplace('C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf')).resolves.toBeUndefined();

        expect(mocks.rename).toHaveBeenNthCalledWith(1, 'C:\\out\\extract.pdf', expect.stringContaining('C:\\out\\extract.pdf.bak-'));
        expect(mocks.rename).toHaveBeenNthCalledWith(2, 'C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf');
        expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    it('still rejects unexpected temp-file fsync failures', async () => {
        setPlatform('darwin');
        const fsyncError = Object.assign(new Error('operation not permitted, fsync'), { code: 'EPERM' });
        mocks.sync.mockRejectedValueOnce(fsyncError);

        const { atomicReplace } = await import('@electron/utils/atomic-replace');

        await expect(atomicReplace('/out/tmp.pdf', '/out/extract.pdf')).rejects.toThrow('operation not permitted');

        expect(mocks.rename).not.toHaveBeenCalled();
        expect(mocks.close).toHaveBeenCalledTimes(1);
    });
});
