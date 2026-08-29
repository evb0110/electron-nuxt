import {
    appendFile,
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

let tempRoot = '';
const execFileAsync = promisify(execFile);

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

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

    it('restores the original when publication changes it and then fails', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare('old-original', 'old-working');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            publishOriginal: async () => {
                await rename(stagedPath, originalPath);
                throw new Error('publication failed');
            },
        })).rejects.toThrow('publication failed');

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
    });

    it('publishes a second witnessed save when the original and working copy share an inode', async () => {
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare();
        const secondStagedPath = join(tempRoot, 'second-staged.pdf');
        await writeFile(secondStagedPath, 'second-committed-pdf');
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        const {refreshWorkingCopyOriginalFileExpectation} = await import('@electron/file-access/workingCopyStore');
        const {captureOriginalPathSaveWitness} = await import('@electron/features/documents/main/originalPathSaveBaseMatches');

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishOriginal: assertDestinationCurrent => publishImmutableFileAtomic(
                stagedPath,
                originalPath,
                {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})},
            ),
            afterWorkingCopySync: async () => {
                expect(await refreshWorkingCopyOriginalFileExpectation(workingCopyPath, 7)).toBe(true);
            },
        })).resolves.toMatchObject({contentRevision: 2});

        const [
            firstOriginalStat,
            firstWorkingStat,
        ] = await Promise.all([
            stat(originalPath, {bigint: true}),
            stat(workingCopyPath, {bigint: true}),
        ]);
        expect(firstOriginalStat.ino).toBe(firstWorkingStat.ino);

        await expect(transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'native-mutation',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishOriginal: assertDestinationCurrent => publishImmutableFileAtomic(
                secondStagedPath,
                originalPath,
                {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})},
            ),
        })).resolves.toMatchObject({contentRevision: 3});

        await expect(readFile(originalPath, 'utf8')).resolves.toBe('second-committed-pdf');
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('second-committed-pdf');
    });

    it('preserves a same-size external replacement made after save admission', async () => {
        const initialBytes = 'original-version';
        const externalBytes = 'external-version';
        expect(Buffer.byteLength(externalBytes)).toBe(Buffer.byteLength(initialBytes));
        const {
            originalPath,
            stagedPath,
            workingCopyPath,
        } = await prepare(initialBytes, 'old-working');
        const publicationPaused = deferred();
        const releasePublication = deferred();
        const {atomicReplace} = await import('@electron/utils/atomicReplace');
        const {transitionOriginalAndWorkingCopyRevision} = await import('@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision');
        const {captureOriginalPathSaveWitness} = await import('@electron/features/documents/main/originalPathSaveBaseMatches');

        const transition = transitionOriginalAndWorkingCopyRevision({
            workingCopyPath,
            originalPath,
            reason: 'save-sync',
            senderId: 7,
            captureOriginalWitness: () => captureOriginalPathSaveWitness(workingCopyPath, originalPath, 7),
            publishOriginal: async assertDestinationCurrent => {
                publicationPaused.resolve();
                await releasePublication.promise;
                await atomicReplace(stagedPath, originalPath, {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})});
            },
        });

        await publicationPaused.promise;
        await execFileAsync(process.execPath, [
            '-e',
            'const fs = require(\'node:fs/promises\'); const [target, bytes] = process.argv.slice(1); const replacement = `${target}.external`; fs.writeFile(replacement, bytes).then(() => fs.rename(replacement, target));',
            originalPath,
            externalBytes,
        ]);
        releasePublication.resolve();

        await expect(transition).resolves.toBeNull();
        await expect(readFile(originalPath, 'utf8')).resolves.toBe(externalBytes);
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('old-working');
    });
});
