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

    it('reports a successful forced copy-on-write clone', async () => {
        const copyFile = vi.fn(async () => undefined);
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const { attemptWorkingCopyClone } = await import('@electron/file-access/workingCopyDirectory');

        await expect(attemptWorkingCopyClone('/source.pdf', '/target.pdf')).resolves.toBe('cloned');

        expect(copyFile).toHaveBeenCalledTimes(1);
        expect(copyFile).toHaveBeenCalledWith('/source.pdf', '/target.pdf', fsConstants.COPYFILE_FICLONE_FORCE);
    });

    it.each([
        'ENOTSUP',
        'EOPNOTSUPP',
        'ENOSYS',
        'EINVAL',
        'EXDEV',
    ])('reports %s as known unsupported without starting an eager copy', async code => {
        const error = Object.assign(new Error('clone unsupported'), {code});
        const copyFile = vi.fn().mockRejectedValueOnce(error);
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const { attemptWorkingCopyClone } = await import('@electron/file-access/workingCopyDirectory');

        await expect(attemptWorkingCopyClone('/source.pdf', '/target.pdf'))
            .resolves.toBe('known-unsupported');

        expect(copyFile).toHaveBeenCalledOnce();
        expect(copyFile).toHaveBeenCalledWith('/source.pdf', '/target.pdf', fsConstants.COPYFILE_FICLONE_FORCE);
    });

    it('uses the compatible eager fallback for an unknown clone failure', async () => {
        const error = Object.assign(new Error('clone read failed'), {code: 'EIO'});
        const copyFile = vi.fn()
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce(undefined);
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const { attemptWorkingCopyClone } = await import('@electron/file-access/workingCopyDirectory');

        await expect(attemptWorkingCopyClone('/source.pdf', '/target.pdf'))
            .resolves.toBe('unknown-error-eager-fallback');
        expect(copyFile).toHaveBeenCalledTimes(2);
        expect(copyFile).toHaveBeenNthCalledWith(
            1,
            '/source.pdf',
            '/target.pdf',
            fsConstants.COPYFILE_FICLONE_FORCE,
        );
        expect(copyFile).toHaveBeenNthCalledWith(2, '/source.pdf', '/target.pdf');
    });
});
