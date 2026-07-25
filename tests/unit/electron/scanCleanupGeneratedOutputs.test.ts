import {
    mkdir,
    mkdtemp,
    realpath,
    stat,
    symlink,
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
    isScanCleanupGeneratedOutputPath,
    pruneScanCleanupGeneratedOutputs,
    SCAN_CLEANUP_OUTPUT_MAX_AGE_MS,
} from '@electron/features/scan-cleanup/public/generatedOutputs';

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
        await writeFile(path, 'generated');
        expect(isScanCleanupGeneratedOutputPath(path, appTempDir)).toBe(true);

        const partialPath = await createScanCleanupGeneratedOutputPath('/books/My scan.pdf', true, appTempDir);
        expect(partialPath).toMatch(/My scan — cleaned selection\.pdf$/u);
    });

    it('classifies only descendants of the managed output root', async () => {
        const appTempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-classifier-test-'));
        tempDirs.push(appTempDir);
        const root = getScanCleanupOutputRoot(appTempDir);
        const outsidePath = join(appTempDir, 'outside.pdf');
        await writeFile(outsidePath, 'outside');
        expect(isScanCleanupGeneratedOutputPath(outsidePath, appTempDir)).toBe(false);
        const managedPath = join(
            root,
            '01234567-89ab-cdef-0123-456789abcdef',
            'scan — cleaned.pdf',
        );
        await mkdir(join(managedPath, '..'), {recursive: true});
        await writeFile(managedPath, 'generated');

        expect(isScanCleanupGeneratedOutputPath(
            managedPath,
            appTempDir,
        )).toBe(true);
        expect(isScanCleanupGeneratedOutputPath(
            await realpath(managedPath),
            appTempDir,
        )).toBe(true);
        expect(isScanCleanupGeneratedOutputPath(root, appTempDir)).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(
            join(appTempDir, 'scan-cleanup', 'output-sibling', 'scan.pdf'),
            appTempDir,
        )).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(
            outsidePath,
            appTempDir,
        )).toBe(false);
        const nonUuidPath = join(root, 'not-a-run-id', 'scan.pdf');
        const nestedPath = join(
            root,
            '01234567-89ab-cdef-0123-456789abcdef',
            'nested',
            'scan.pdf',
        );
        const nonPdfPath = join(
            root,
            '01234567-89ab-cdef-0123-456789abcdef',
            'scan.png',
        );
        await mkdir(join(nonUuidPath, '..'), {recursive: true});
        await mkdir(join(nestedPath, '..'), {recursive: true});
        await Promise.all([
            writeFile(nonUuidPath, 'generated'),
            writeFile(nestedPath, 'generated'),
            writeFile(nonPdfPath, 'generated'),
        ]);
        expect(isScanCleanupGeneratedOutputPath(nonUuidPath, appTempDir)).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(nestedPath, appTempDir)).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(nonPdfPath, appTempDir)).toBe(false);
        expect(isScanCleanupGeneratedOutputPath(join(root, 'missing.pdf'), appTempDir)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('rejects symlink escapes from the managed root', async () => {
        const appTempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-symlink-test-'));
        tempDirs.push(appTempDir);
        const root = getScanCleanupOutputRoot(appTempDir);
        const outsidePath = join(appTempDir, 'outside.pdf');
        const runDirectory = join(root, '01234567-89ab-cdef-0123-456789abcdef');
        await mkdir(runDirectory, {recursive: true});
        await writeFile(outsidePath, 'outside');
        const linkedPdf = join(runDirectory, 'scan.pdf');
        await symlink(outsidePath, linkedPdf);

        expect(isScanCleanupGeneratedOutputPath(linkedPdf, appTempDir)).toBe(false);
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
