import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'fs';
import {
    dirname,
    join,
} from 'path';
import { tmpdir } from 'os';
import type * as NodeCrypto from 'node:crypto';
import type * as DocumentRevisionSidecarModule from '@electron/file-access/documentRevisionSidecar';

let tempRoot = '';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => tempRoot) } }));

vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof NodeCrypto>();
    let index = 0;
    return {
        ...actual,
        randomUUID: () => `00000000-0000-4000-8000-${(index += 1).toString().padStart(12, '0')}`,
    };
});

describe('documentRevisionStore', () => {
    beforeEach(() => {
        vi.resetModules();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-document-revision-test-'));
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('mints, persists, reloads, and rejects stale working-copy revision tokens', async () => {
        const originalPath = join(tempRoot, 'original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-revision', 'original.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            assertWorkingCopyRevisionCurrent,
            ensureWorkingCopyRevision,
            isWorkingCopyRevisionCurrent,
            markWorkingCopyRevisionChanged,
        } = await import('@electron/file-access/documentRevisionStore');
        const {
            readWorkingCopyRevisionSidecar,
            writeWorkingCopyRevisionSidecar,
        } = await import('@electron/file-access/documentRevisionSidecar');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        const revision = await ensureWorkingCopyRevision(workingPath, 7);
        const persisted = await readWorkingCopyRevisionSidecar(workingPath);

        expect(revision).toMatchObject({
            version: 1,
            documentRef: workingPath,
            authority: 'electron-working-copy',
            contentRevision: 1,
        });
        expect(revision.token).toMatch(/^drt1:1:1:/u);
        expect(persisted?.token).toBe(revision.token);

        const changed = await markWorkingCopyRevisionChanged(workingPath, 'write', 7);

        expect(changed.previousToken).toBe(revision.token);
        expect(changed.contentRevision).toBe(2);
        expect(changed.token).toMatch(/^drt1:1:2:/u);
        await expect(isWorkingCopyRevisionCurrent(workingPath, revision.token)).resolves.toBe(false);
        await expect(assertWorkingCopyRevisionCurrent(workingPath, revision.token))
            .rejects
            .toMatchObject({code: 'STALE_REVISION'});

        await writeWorkingCopyRevisionSidecar(workingPath, {
            sidecarVersion: 1,
            ...changed,
            updatedAt: changed.mintedAt,
        });
        vi.resetModules();
        const { getWorkingCopyRevision } = await import('@electron/file-access/documentRevisionStore');

        await expect(getWorkingCopyRevision(workingPath, 7))
            .resolves
            .toMatchObject({
                token: changed.token,
                contentRevision: 2,
            });
    });

    it('marks content changes and clears derived artifacts', async () => {
        const originalPath = join(tempRoot, 'artifact-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-artifacts', 'artifact-original.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const ocrDir = `${workingPath}.ocr`;
        mkdirSync(ocrDir, {recursive: true});
        writeFileSync(join(ocrDir, 'page-1.json'), '{}');
        writeFileSync(`${workingPath}.index.json`, '{}');
        const { getCompactSearchIndexPath } = await import('@electron/search/searchIndexSidecar');
        const compactSearchIndexPath = getCompactSearchIndexPath(workingPath);
        writeFileSync(compactSearchIndexPath, new Uint8Array([1]));

        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            ensureWorkingCopyRevision,
            isWorkingCopyRevisionCurrent,
            markWorkingCopyContentChanged,
        } = await import('@electron/file-access/documentRevisionStore');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        const revision = await ensureWorkingCopyRevision(workingPath, 7);
        const changed = await markWorkingCopyContentChanged(workingPath, 'page-ops', 7);

        expect(changed.previousToken).toBe(revision.token);
        expect(changed.reason).toBe('page-ops');
        await expect(isWorkingCopyRevisionCurrent(workingPath, revision.token)).resolves.toBe(false);
        expect(existsSync(ocrDir)).toBe(false);
        expect(existsSync(`${workingPath}.index.json`)).toBe(false);
        expect(existsSync(compactSearchIndexPath)).toBe(false);
    });

    it('reconciles a pending revision sidecar journal after module reload', async () => {
        const originalPath = join(tempRoot, 'journal-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-journal', 'journal-original.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const { ensureWorkingCopyRevision } = await import('@electron/file-access/documentRevisionStore');
        const {
            readWorkingCopyRevisionJournalEntries,
            readWorkingCopyRevisionSidecar,
            stageWorkingCopyRevisionSidecarCommit,
        } = await import('@electron/file-access/documentRevisionSidecar');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        const revision = await ensureWorkingCopyRevision(workingPath, 7);
        const nextSidecar = {
            sidecarVersion: 1 as const,
            version: 1 as const,
            documentRef: workingPath,
            authority: 'electron-working-copy' as const,
            token: 'drt1:journal:2:pending',
            contentRevision: revision.contentRevision + 1,
            mintedAt: Date.now(),
            updatedAt: Date.now(),
        };
        stageWorkingCopyRevisionSidecarCommit(workingPath, nextSidecar, 'save-sync');

        expect(readWorkingCopyRevisionJournalEntries(workingPath))
            .toEqual([expect.objectContaining({
                kind: 'revision-sidecar-commit',
                sidecar: expect.objectContaining({token: nextSidecar.token}),
            })]);

        vi.resetModules();
        const { getWorkingCopyRevision } = await import('@electron/file-access/documentRevisionStore');
        const {
            readWorkingCopyRevisionJournalEntries: readReloadedJournalEntries,
            readWorkingCopyRevisionSidecar: readReloadedRevisionSidecar,
        } = await import('@electron/file-access/documentRevisionSidecar');

        await expect(getWorkingCopyRevision(workingPath, 7))
            .resolves
            .toMatchObject({
                token: nextSidecar.token,
                contentRevision: nextSidecar.contentRevision,
            });
        await expect(readReloadedRevisionSidecar(workingPath))
            .resolves
            .toMatchObject({
                token: nextSidecar.token,
                contentRevision: nextSidecar.contentRevision,
            });
        expect(readReloadedJournalEntries(workingPath)
            .some(entry => entry.kind === 'revision-sidecar-commit')).toBe(false);
        await expect(readWorkingCopyRevisionSidecar(workingPath))
            .resolves
            .toMatchObject({token: nextSidecar.token});
    });

    it('persists sync-required state in a bounded per-working-copy journal', async () => {
        const originalPath = join(tempRoot, 'sync-required-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-sync-required', 'sync-required-original.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            assertWorkingCopyMutationAllowed,
            ensureWorkingCopyRevision,
            markWorkingCopySyncRequired,
        } = await import('@electron/file-access/documentRevisionStore');
        const { readWorkingCopyRevisionJournalEntries } = await import('@electron/file-access/documentRevisionSidecar');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);
        await ensureWorkingCopyRevision(workingPath, 7);

        for (let index = 0; index < 12; index += 1) {
            markWorkingCopySyncRequired(workingPath, `copy-back failed ${index}`);
        }

        const syncEntries = readWorkingCopyRevisionJournalEntries(workingPath)
            .filter(entry => entry.kind === 'working-copy-sync-required');
        expect(syncEntries).toHaveLength(1);
        expect(syncEntries[0]).toMatchObject({
            reason: 'copy-back failed 11',
            targetWriteCommitted: true,
            originalPath,
            ownerWebContentsId: 7,
        });
        expect(() => assertWorkingCopyMutationAllowed(workingPath))
            .toThrow('copy-back failed 11');

        vi.resetModules();
        const {
            assertWorkingCopyMutationAllowed: assertReloadedWorkingCopyMutationAllowed,
            clearWorkingCopySyncRequired,
        } = await import('@electron/file-access/documentRevisionStore');

        expect(() => assertReloadedWorkingCopyMutationAllowed(workingPath))
            .toThrow('copy-back failed 11');
        clearWorkingCopySyncRequired(workingPath);
        expect(() => assertReloadedWorkingCopyMutationAllowed(workingPath)).not.toThrow();
    });

    it('does not replay stale revision journal entries over a newer sidecar', async () => {
        const originalPath = join(tempRoot, 'journal-stale-original.pdf');
        const workingPath = join(tempRoot, 'pdf-work-journal-stale', 'journal-stale-original.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));

        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            readWorkingCopyRevisionJournalEntries,
            readWorkingCopyRevisionSidecar,
            stageWorkingCopyRevisionSidecarCommit,
            writeWorkingCopyRevisionSidecar,
        } = await import('@electron/file-access/documentRevisionSidecar');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);
        const newerSidecar = {
            sidecarVersion: 1 as const,
            version: 1 as const,
            documentRef: workingPath,
            authority: 'electron-working-copy' as const,
            token: 'drt1:journal:3:current',
            contentRevision: 3,
            mintedAt: Date.now(),
            updatedAt: Date.now(),
        };
        const staleSidecar = {
            ...newerSidecar,
            token: 'drt1:journal:2:stale',
            contentRevision: 2,
        };
        await writeWorkingCopyRevisionSidecar(workingPath, newerSidecar);
        stageWorkingCopyRevisionSidecarCommit(workingPath, staleSidecar, 'save-sync');

        await expect(readWorkingCopyRevisionSidecar(workingPath))
            .resolves
            .toMatchObject({
                token: newerSidecar.token,
                contentRevision: newerSidecar.contentRevision,
            });
        expect(readWorkingCopyRevisionJournalEntries(workingPath)
            .some(entry => entry.kind === 'revision-sidecar-commit')).toBe(false);
    });

    it('keeps sync-required state authoritative when journal persistence fails', async () => {
        vi.doMock('@electron/file-access/documentRevisionSidecar', async (importOriginal) => {
            const actual = await importOriginal<typeof DocumentRevisionSidecarModule>();
            return {
                ...actual,
                clearWorkingCopySyncRequiredJournalEntry: vi.fn(() => {
                    throw new Error('journal clear failed');
                }),
                readWorkingCopySyncRequiredJournalEntry: vi.fn(() => null),
                writeWorkingCopySyncRequiredJournalEntry: vi.fn(() => {
                    throw new Error('journal write failed');
                }),
            };
        });
        const {
            assertWorkingCopyMutationAllowed,
            clearWorkingCopySyncRequired,
            markWorkingCopySyncRequired,
        } = await import('@electron/file-access/documentRevisionStore');
        const workingPath = join(tempRoot, 'pdf-work-journal-failure', 'journal-failure.pdf');

        markWorkingCopySyncRequired(workingPath, 'copy-back failed despite journal failure');

        expect(() => assertWorkingCopyMutationAllowed(workingPath))
            .toThrow('copy-back failed despite journal failure');
        expect(() => clearWorkingCopySyncRequired(workingPath)).not.toThrow();
        expect(() => assertWorkingCopyMutationAllowed(workingPath)).not.toThrow();

        vi.doUnmock('@electron/file-access/documentRevisionSidecar');
    });
});
