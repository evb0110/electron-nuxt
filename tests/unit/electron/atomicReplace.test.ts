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
    stat: vi.fn(),
    sync: vi.fn(),
    unlink: vi.fn(),
}));

const originalPlatform = process.platform;

vi.mock('node:crypto', () => ({ randomBytes: () => Buffer.from('fixed-id') }));

vi.mock('fs/promises', () => ({
    open: (...args: unknown[]) => mocks.open(...args),
    rename: (...args: unknown[]) => mocks.rename(...args),
    stat: (...args: unknown[]) => mocks.stat(...args),
    unlink: (...args: unknown[]) => mocks.unlink(...args),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
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
        mocks.stat.mockResolvedValue({});
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

        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf')).resolves.toBeUndefined();

        expect(mocks.rename).toHaveBeenNthCalledWith(1, 'C:\\out\\extract.pdf', expect.stringContaining('C:\\out\\extract.pdf.bak-'));
        expect(mocks.rename).toHaveBeenNthCalledWith(2, 'C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf');
        expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    it('still rejects unexpected temp-file fsync failures', async () => {
        setPlatform('darwin');
        const fsyncError = Object.assign(new Error('operation not permitted, fsync'), { code: 'EPERM' });
        mocks.sync.mockRejectedValueOnce(fsyncError);

        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('/out/tmp.pdf', '/out/extract.pdf')).rejects.toThrow('operation not permitted');

        expect(mocks.rename).not.toHaveBeenCalled();
        expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    it('uses one same-directory rename on POSIX so the destination is never moved aside first', async () => {
        setPlatform('darwin');
        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('/out/tmp.pdf', '/out/extract.pdf')).resolves.toBeUndefined();

        expect(mocks.rename).toHaveBeenCalledTimes(1);
        expect(mocks.rename).toHaveBeenCalledWith('/out/tmp.pdf', '/out/extract.pdf');
        expect(mocks.unlink).not.toHaveBeenCalled();
    });

    it('reports both promotion and restore failures on Windows', async () => {
        setPlatform('win32');
        mocks.rename
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('promotion failed'))
            .mockRejectedValueOnce(new Error('restore failed'));
        mocks.stat.mockImplementation(async (path: string) => {
            if (path.includes('.bak-')) {
                return {};
            }
            throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        });

        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf'))
            .rejects
            .toThrow(/Promotion error: promotion failed.*Restore error: restore failed.*Backup path: "C:\\out\\extract\.pdf\.bak-.*Destination exists: no/u);
    });

    it('moves a live Windows destination aside for a non-durable cache publication', async () => {
        setPlatform('win32');
        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        // A retained scan-cleanup raster is republished over a path a sidecar
        // manifest may still be reading. A bare rename onto that destination
        // fails EPERM/EACCES on Windows; the replace moves it aside first.
        await expect(atomicReplace('C:\\scratch\\page.part.png', 'C:\\scratch\\page-1-150.png', {
            durable: false,
            markMutationCommitStarted: false,
        })).resolves.toBeUndefined();

        expect(mocks.rename).toHaveBeenNthCalledWith(
            1,
            'C:\\scratch\\page-1-150.png',
            expect.stringContaining('C:\\scratch\\page-1-150.png.bak-'),
        );
        expect(mocks.rename).toHaveBeenNthCalledWith(2, 'C:\\scratch\\page.part.png', 'C:\\scratch\\page-1-150.png');
        // A within-run cache lives in a scratch directory that is discarded on
        // exit, so it never pays for the durability fsyncs.
        expect(mocks.sync).not.toHaveBeenCalled();
    });

    it('keeps the destination readable when Windows cannot remove the moved-aside file', async () => {
        setPlatform('win32');
        mocks.unlink.mockRejectedValueOnce(Object.assign(new Error('in use'), { code: 'EBUSY' }));
        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        // The reader still holding the old bytes keeps them; the new raster is
        // in place regardless.
        await expect(atomicReplace('C:\\scratch\\page.part.png', 'C:\\scratch\\page-1-150.png', {
            durable: false,
            markMutationCommitStarted: false,
        })).resolves.toBeUndefined();

        expect(mocks.rename).toHaveBeenNthCalledWith(2, 'C:\\scratch\\page.part.png', 'C:\\scratch\\page-1-150.png');
    });
});
