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
        setWorkingCopyOriginalPath(workingPath, originalPath, 7);

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
        setWorkingCopyOriginalPath(workingPath, originalPath, 7);

        const revision = await ensureWorkingCopyRevision(workingPath, 7);
        const changed = await markWorkingCopyContentChanged(workingPath, 'page-ops', 7);

        expect(changed.previousToken).toBe(revision.token);
        expect(changed.reason).toBe('page-ops');
        await expect(isWorkingCopyRevisionCurrent(workingPath, revision.token)).resolves.toBe(false);
        expect(existsSync(ocrDir)).toBe(false);
        expect(existsSync(`${workingPath}.index.json`)).toBe(false);
        expect(existsSync(compactSearchIndexPath)).toBe(false);
    });
});
