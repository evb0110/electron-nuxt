import {
    mkdtemp,
    readFile,
    rename,
    rm,
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
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {capturePathSaveWitness} from '@electron/file-access/originalPathSaveWitness';
import type * as DocumentFileWriteAtomicModule from '@electron/file-access/documentFileWriteAtomic';
import {writeWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';

interface ICopyFileAtomicOptions {assertDestinationCurrent?: () => Promise<void>}

type TCopyFileAtomic = (
    sourcePath: string,
    targetPath: string,
    options?: ICopyFileAtomicOptions,
) => Promise<void>;

const mocks = vi.hoisted(() => ({copyFileAtomic: vi.fn<TCopyFileAtomic>()}));

vi.mock('@electron/file-access/documentFileWriteAtomic', async importOriginal => {
    const actual = await importOriginal<typeof DocumentFileWriteAtomicModule>();
    return {
        ...actual,
        copyFileAtomic: mocks.copyFileAtomic,
    };
});

describe('two-target document transition recovery fencing', () => {
    let root = '';

    beforeEach(() => {
        vi.resetModules();
        mocks.copyFileAtomic.mockReset();
    });

    afterEach(async () => {
        await rm(root, {
            recursive: true,
            force: true,
        });
    });

    async function prepare() {
        root = await mkdtemp(join(tmpdir(), 'evb-two-target-fence-'));
        const workingCopyPath = join(root, 'working.pdf');
        const originalPath = join(root, 'original.pdf');
        const originalBackupPath = join(root, 'original.backup.pdf');
        const nextRevisionToken = requireDocumentRevisionToken('drt1:test:next');
        await Promise.all([
            writeFile(workingCopyPath, 'new-working-copy'),
            writeFile(originalPath, 'new-original'),
            writeFile(originalBackupPath, 'old-original'),
            writeWorkingCopyRevisionSidecar(workingCopyPath, {
                sidecarVersion: 1,
                version: 1,
                documentRef: workingCopyPath,
                authority: 'electron-working-copy',
                token: requireDocumentRevisionToken('drt1:test:old'),
                contentRevision: 2,
                mintedAt: 2,
                updatedAt: 2,
            }),
            writeFile(`${workingCopyPath}.evb-two-target-transition.json`, JSON.stringify({
                version: 1,
                state: 'original-committed',
                workingCopyPath,
                originalPath,
                originalBackupPath,
                nextRevisionToken,
            })),
        ]);
        return {
            workingCopyPath,
            originalPath,
            originalBackupPath,
        };
    }

    it('passes a current-destination fence before crash recovery restore', async () => {
        const {
            workingCopyPath,
            originalPath,
            originalBackupPath,
        } = await prepare();
        mocks.copyFileAtomic.mockImplementation(async (_sourcePath, targetPath, options) => {
            const externalPath = `${targetPath}.external`;
            await writeFile(externalPath, 'external-replacement');
            await rename(externalPath, targetPath);
            await options?.assertDestinationCurrent?.();
        });
        const {recoverTwoTargetDocumentTransition} = await import('@electron/file-access/recoverTwoTargetDocumentTransition');

        await expect(recoverTwoTargetDocumentTransition(workingCopyPath))
            .rejects
            .toThrow('Original file changed on disk; save skipped to avoid overwriting external edits');

        expect(mocks.copyFileAtomic).toHaveBeenCalledWith(
            originalBackupPath,
            originalPath,
            {assertDestinationCurrent: expect.any(Function)},
        );
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('external-replacement');
        await expect(readFile(originalBackupPath, 'utf8')).resolves.toBe('old-original');
        await expect(readFile(`${workingCopyPath}.evb-two-target-transition.json`, 'utf8')).resolves.toContain('original-committed');
    });

    it('rejects a replacement that predates crash recovery', async () => {
        const {
            workingCopyPath,
            originalPath,
            originalBackupPath,
        } = await prepare();
        const witness = await capturePathSaveWitness(originalPath);
        expect(witness).not.toBeNull();
        const publishedOriginalSnapshot = witness!.getSnapshotForJournal();
        await witness!.close();
        await writeFile(originalPath, 'external-before-recovery');
        await writeFile(`${workingCopyPath}.evb-two-target-transition.json`, JSON.stringify({
            version: 1,
            state: 'original-committed',
            workingCopyPath,
            originalPath,
            originalBackupPath,
            nextRevisionToken: requireDocumentRevisionToken('drt1:test:next'),
            publishedOriginalSnapshot,
        }));

        const {recoverTwoTargetDocumentTransition} = await import('@electron/file-access/recoverTwoTargetDocumentTransition');
        await expect(recoverTwoTargetDocumentTransition(workingCopyPath))
            .rejects
            .toThrow('Original file changed on disk; save skipped to avoid overwriting external edits');
        await expect(readFile(originalPath, 'utf8')).resolves.toBe('external-before-recovery');
        await expect(readFile(originalBackupPath, 'utf8')).resolves.toBe('old-original');
    });
});
