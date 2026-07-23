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

    it.each([
        'ENOTSUP',
        'ENOSYS',
        'EINVAL',
        'EXDEV',
    ])('falls back to a plain copy for %s clone failures', async code => {
        const error = Object.assign(new Error('clone unsupported'), {code});
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

    it('does not hide unexpected clone failures with a plain copy', async () => {
        const error = Object.assign(new Error('clone read failed'), {code: 'EIO'});
        const copyFile = vi.fn().mockRejectedValueOnce(error);
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const { copyFileCopyOnWrite } = await import('@electron/file-access/workingCopyDirectory');

        await expect(copyFileCopyOnWrite('/source.pdf', '/target.pdf')).rejects.toBe(error);
        expect(copyFile).toHaveBeenCalledOnce();
    });
});
