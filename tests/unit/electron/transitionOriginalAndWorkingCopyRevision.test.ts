import {
    appendFile,
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
    vi,
} from 'vitest';

let tempRoot = '';

vi.mock('electron', () => ({app: {getPath: vi.fn(() => tempRoot)}}));

describe('transitionOriginalAndWorkingCopyRevision', () => {
    beforeEach(async () => {
        vi.resetModules();
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-two-target-transition-test-'));
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
    });

    afterEach(async () => {
        delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        await rm(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    async function prepare(initialOriginal = 'old-original', initialWorking = 'old-working') {
        const originalPath = join(tempRoot, 'original.pdf');
        const workingCopyPath = join(tempRoot, 'working.pdf');
        const stagedPath = join(tempRoot, 'staged.pdf');
        await Promise.all([
            writeFile(originalPath, initialOriginal),
            writeFile(workingCopyPath, initialWorking),
            writeFile(stagedPath, 'new-committed-pdf'),
        ]);

        const {setWorkingCopyOriginalPath} = await import('@electron/file-access/workingCopyStore');
        const {ensureWorkingCopyRevision} = await import('@electron/file-access/documentRevisionStore');
        await setWorkingCopyOriginalPath(workingCopyPath, originalPath, 7, {backingState: 'eager'});
        await ensureWorkingCopyRevision(workingCopyPath, 7);

        return {
            originalPath,
            stagedPath,
            workingCopyPath,
        };
    }

    it('links an immutable original into the working-copy path when reflinks are unavailable', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare();
        const phases: string[] = [];
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
        const {originalPathSaveBaseMatches} = await import('@electron/features/documents/main/originalPathSaveBaseMatches');

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            publishOriginal: () => publishImmutableFileAtomic(stagedPath, originalPath),
            afterWorkingCopySync: async () => {
                expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
            },
            onPhase: phase => phases.push(phase),
        })).resolves.toMatchObject({
            contentRevision: 2,
            reason: 'native-mutation',
        });

        const [
            originalStat,
            workingStat,
        ] = await Promise.all([
            stat(originalPath, {bigint: true}),
            stat(workingCopyPath, {bigint: true}),
        ]);
        expect(originalStat.ino).toBe(workingStat.ino);
        expect(originalStat.nlink).toBeGreaterThanOrEqual(2n);
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('new-committed-pdf');
        expect(phases).toContain('transition-sync-working-copy-link');
        expect(phases).not.toContain('transition-sync-working-copy-copy');
        await expect(originalPathSaveBaseMatches(workingCopyPath, originalPath, 7)).resolves.toBe(true);

        await appendFile(originalPath, '-external-change');
        await expect(originalPathSaveBaseMatches(workingCopyPath, originalPath, 7)).resolves.toBe(false);
    });

    it('restores distinct original and working-copy inodes when post-sync work fails', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare('old-original', 'old-working');
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            publishOriginal: () => publishImmutableFileAtomic(stagedPath, originalPath),
            afterWorkingCopySync: async () => {
                throw new Error('post-sync failure');
            },
        })).rejects.toThrow('post-sync failure');

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
        const [
            originalStat,
            workingStat,
        ] = await Promise.all([
            stat(originalPath, {bigint: true}),
            stat(workingCopyPath, {bigint: true}),
        ]);
        expect(originalStat.ino).not.toBe(workingStat.ino);
    });
});
