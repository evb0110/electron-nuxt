import {
    mkdir,
    mkdtemp,
    stat,
    utimes,
    writeFile,
} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createScanCleanupGeneratedOutputPath,
    getScanCleanupOutputRoot,
    pruneScanCleanupGeneratedOutputs,
    SCAN_CLEANUP_OUTPUT_MAX_AGE_MS,
} from '@electron/features/scan-cleanup/scanCleanupGeneratedOutputs';

const tempDirs: string[] = [];

afterEach(async () => {
    const {rm} = await import('fs/promises');
    await Promise.all(tempDirs.splice(0).map(path => rm(path, {
        recursive: true,
        force: true,
    })));
});

describe('scan cleanup generated output pruning', () => {
    it('creates a managed, human-readable output path without a save dialog', async () => {
        const appTempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-path-test-'));
        tempDirs.push(appTempDir);
        const path = await createScanCleanupGeneratedOutputPath('/books/My scan.pdf', false, appTempDir);
        expect(path).toMatch(/scan-cleanup[/\\]output[/\\][^/\\]+[/\\]My scan — cleaned\.pdf$/u);
        await expect(stat(join(path, '..'))).resolves.toBeDefined();

        const partialPath = await createScanCleanupGeneratedOutputPath('/books/My scan.pdf', true, appTempDir);
        expect(partialPath).toMatch(/My scan — cleaned selection\.pdf$/u);
    });

    it('removes only stale output entries that are not open', async () => {
        const appTempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-test-'));
        tempDirs.push(appTempDir);
        const root = getScanCleanupOutputRoot(appTempDir);
        const stale = join(root, 'stale');
        const open = join(root, 'open');
        const fresh = join(root, 'fresh');
        await Promise.all([
            stale,
            open,
            fresh,
        ].map(path => mkdir(path, {recursive: true})));
        const stalePdf = join(stale, 'stale — cleaned.pdf');
        const openPdf = join(open, 'open — cleaned.pdf');
        const freshPdf = join(fresh, 'fresh — cleaned.pdf');
        await Promise.all([
            writeFile(stalePdf, 'stale'),
            writeFile(openPdf, 'open'),
            writeFile(freshPdf, 'fresh'),
        ]);
        const nowMs = Date.now();
        const oldSeconds = (nowMs - SCAN_CLEANUP_OUTPUT_MAX_AGE_MS - 1_000) / 1_000;
        await Promise.all([
            utimes(stale, oldSeconds, oldSeconds),
            utimes(open, oldSeconds, oldSeconds),
        ]);

        await expect(pruneScanCleanupGeneratedOutputs({
            appTempDir,
            openPdfPaths: [openPdf],
            nowMs,
        })).resolves.toBe(1);
        await expect(stat(stale)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(stat(open)).resolves.toBeDefined();
        await expect(stat(fresh)).resolves.toBeDefined();
    });
});
