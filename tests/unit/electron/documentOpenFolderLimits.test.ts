import {
    mkdtemp,
    mkdir,
    rm,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { collectSupportedFolderPaths } from '@electron/features/documents/main/documentOpenHandlers';

const temporaryPaths: string[] = [];

describe('document folder open limits', () => {
    afterEach(async () => {
        await Promise.all(temporaryPaths.splice(0).map(path => rm(path, {
            recursive: true,
            force: true,
        })));
    });

    it('sorts supported files while ignoring directories and unsupported files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-open-folder-'));
        temporaryPaths.push(directory);
        await Promise.all([
            writeFile(join(directory, 'b.png'), ''),
            writeFile(join(directory, 'a.jpg'), ''),
            writeFile(join(directory, 'notes.txt'), ''),
            mkdir(join(directory, 'nested.png')),
        ]);

        await expect(collectSupportedFolderPaths(directory)).resolves.toEqual([
            join(directory, 'a.jpg'),
            join(directory, 'b.png'),
        ]);
    });

    it('stops once the supported-file admission limit is exceeded', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-open-folder-limit-'));
        temporaryPaths.push(directory);
        await Promise.all(Array.from({length: 513}, (_, index) => (
            writeFile(join(directory, `${String(index).padStart(4, '0')}.png`), '')
        )));

        await expect(collectSupportedFolderPaths(directory))
            .rejects.toThrow('Open batch exceeds maximum size (512)');
    });
});
