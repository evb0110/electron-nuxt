import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';

describe('documentFileWriteAtomic immutable-source fallback', () => {
    let tempRoot = '';

    beforeEach(async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-atomic-copy-fallback-'));
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
        process.env.EVB_TEST_FORCE_IMMUTABLE_LINK_RESULT = 'cross-device';
    });

    afterEach(async () => {
        delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        delete process.env.EVB_TEST_FORCE_IMMUTABLE_LINK_RESULT;
        await rm(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('copies to a distinct inode when the immutable hard link crosses a device', async () => {
        const sourcePath = join(tempRoot, 'source.pdf');
        const targetPath = join(tempRoot, 'target.pdf');
        await writeFile(sourcePath, 'source bytes');
        const phases: string[] = [];
        const {copyFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');

        await copyFileAtomic(sourcePath, targetPath, {
            durable: false,
            linkImmutableSource: true,
            onPhase: phase => phases.push(phase),
        });

        await expect(readFile(targetPath, 'utf8')).resolves.toBe('source bytes');
        const [
            sourceStat,
            targetStat,
        ] = await Promise.all([
            stat(sourcePath, {bigint: true}),
            stat(targetPath, {bigint: true}),
        ]);
        expect(sourceStat.ino).not.toBe(targetStat.ino);
        expect(phases).toEqual(expect.arrayContaining([
            'clone',
            'link',
            'copy',
            'rename',
        ]));
    });
});
