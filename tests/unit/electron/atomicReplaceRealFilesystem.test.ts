import {
    mkdtemp,
    readFile,
    readlink,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {atomicReplace} from '@electron/utils/atomicReplace';

describe('atomicReplace real filesystem policy', () => {
    let root = '';

    afterEach(async () => {
        await rm(root, {
            force: true,
            recursive: true,
        });
    });

    it.skipIf(process.platform === 'win32')('rejects a symlink destination without replacing the link or referent', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-real-'));
        const sourcePath = join(root, 'source.pdf');
        const referentPath = join(root, 'referent.pdf');
        const destinationPath = join(root, 'destination.pdf');
        await writeFile(sourcePath, 'new bytes');
        await writeFile(referentPath, 'referent bytes');
        await symlink(referentPath, destinationPath);

        await expect(atomicReplace(sourcePath, destinationPath))
            .rejects
            .toThrow(`Invalid file path: symlink path segment is not allowed (${destinationPath})`);
        await expect(readlink(destinationPath)).resolves.toBe(referentPath);
        await expect(readFile(referentPath, 'utf8')).resolves.toBe('referent bytes');
        await expect(readFile(sourcePath, 'utf8')).resolves.toBe('new bytes');
    });
});
