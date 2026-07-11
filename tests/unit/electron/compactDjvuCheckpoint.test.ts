import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    loadOrBuildCompactDjvuPage,
    openCompactDjvuCheckpointJob,
} from '@electron/features/djvu/main/compactDjvuCheckpoint';

describe('compact DjVu checkpoints', () => {
    let tempDir = '';
    afterEach(async () => rm(tempDir, {
        recursive: true,
        force: true,
    }));

    it('reuses a verified per-page artifact after reopening the job', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'compact-checkpoint-test-'));
        const sourcePath = join(tempDir, 'source.djvu');
        await writeFile(sourcePath, 'fixture');
        const build = vi.fn(async () => ({
            pageNumber: 1,
            manifestLine: 'mask\t72\t72\t/tmp/mask.pbm',
            kind: 'bitonal' as const,
            reason: 'test',
            effectivePpi: 300,
        }));

        const first = await openCompactDjvuCheckpointJob(sourcePath, [1], 'balanced');
        await loadOrBuildCompactDjvuPage(first, 0, build);
        const reopened = await openCompactDjvuCheckpointJob(sourcePath, [1], 'balanced');
        await loadOrBuildCompactDjvuPage(reopened, 0, build);

        expect(build).toHaveBeenCalledTimes(1);
        expect(reopened.manifest.ranges[0]).toMatchObject({status: 'verified'});
    });
});
