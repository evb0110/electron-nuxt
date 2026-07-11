import {
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { openDjvuArtifactJob } from '@electron/features/djvu/main/djvuArtifactManifest';

describe('DjVu artifact manifests', () => {
    const directories: string[] = [];

    afterEach(() => {
        for (const directory of directories) {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
        directories.length = 0;
    });

    it('reuses verified page ranges and resets interrupted ranges', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-manifest-test-'));
        directories.push(directory);
        const sourcePath = join(directory, 'source.djvu');
        writeFileSync(sourcePath, 'djvu-source');
        const ranges = [
            {
                startPage: 1,
                endPage: 2,
            },
            {
                startPage: 3,
                endPage: 4,
            },
        ];
        const first = await openDjvuArtifactJob(sourcePath, ranges, {});
        writeFileSync(first.manifest.ranges[0]!.outputPath, 'valid-pdf-range');
        await first.updateRange(0, {
            status: 'verified',
            size: 15,
        });
        await first.updateRange(1, {status: 'running'});

        const resumed = await openDjvuArtifactJob(sourcePath, ranges, {});

        expect(resumed.directory).toBe(first.directory);
        expect(resumed.manifest.ranges.map(range => range.status)).toEqual([
            'verified',
            'pending',
        ]);
    });
});
