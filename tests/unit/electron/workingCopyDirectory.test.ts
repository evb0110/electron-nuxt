import { constants as fsConstants } from 'fs';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

describe('workingCopyDirectory', () => {
    afterEach(() => {
        vi.doUnmock('fs/promises');
        vi.resetModules();
    });

    it('tries a copy-on-write clone without requiring filesystem clone support', async () => {
        const copyFile = vi.fn(async () => undefined);
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const { copyFileCopyOnWrite } = await import('@electron/file-access/workingCopyDirectory');

        await copyFileCopyOnWrite('/source.pdf', '/target.pdf');

        expect(copyFile).toHaveBeenCalledTimes(1);
        expect(copyFile).toHaveBeenCalledWith('/source.pdf', '/target.pdf', fsConstants.COPYFILE_FICLONE);
        expect(copyFile).not.toHaveBeenCalledWith('/source.pdf', '/target.pdf', fsConstants.COPYFILE_FICLONE_FORCE);
    });

    it('falls back to a plain copy when clone support is unavailable', async () => {
        const error = Object.assign(new Error('clone unsupported'), {code: 'ENOSYS'});
        const copyFile = vi.fn()
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce(undefined);
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const { copyFileCopyOnWrite } = await import('@electron/file-access/workingCopyDirectory');

        await copyFileCopyOnWrite('/source.pdf', '/target.pdf');

        expect(copyFile).toHaveBeenCalledTimes(2);
        expect(copyFile).toHaveBeenNthCalledWith(1, '/source.pdf', '/target.pdf', fsConstants.COPYFILE_FICLONE);
        expect(copyFile).toHaveBeenNthCalledWith(2, '/source.pdf', '/target.pdf');
    });
});
