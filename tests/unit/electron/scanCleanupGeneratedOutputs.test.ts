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
import {
    basename,
    join,
} from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createScanCleanupGeneratedOutputPath,
    getScanCleanupOutputRoot,
    isScanCleanupGeneratedOutputPath,
    pruneScanCleanupGeneratedOutputs,
    SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES,
    SCAN_CLEANUP_OUTPUT_MAX_AGE_MS,
} from '@electron/features/scan-cleanup/public/generatedOutputs';
import {
    clearWorkingCopyOriginalPaths,
    isWorkingCopyOriginalPathRegistered,
    setWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';

const tempDirs: string[] = [];

beforeEach(() => {
    clearWorkingCopyOriginalPaths();
});

afterEach(async () => {
    clearWorkingCopyOriginalPaths();
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

    it('byte-caps long Unicode names with a deterministic collision hash and writable suffix', async () => {
        const appTempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-long-name-test-'));
        tempDirs.push(appTempDir);
        const commonPrefix = '漢'.repeat(200);
        const sourceA = `/books/${commonPrefix}甲.pdf`;
        const sourceB = `/books/${commonPrefix}乙.pdf`;
        const [
            pathA,
            pathB,
            repeatedPathA,
        ] = await Promise.all([
            createScanCleanupGeneratedOutputPath(sourceA, false, appTempDir),
            createScanCleanupGeneratedOutputPath(sourceB, false, appTempDir),
            createScanCleanupGeneratedOutputPath(sourceA, false, appTempDir),
        ]);
        const leafA = basename(pathA);
        const leafB = basename(pathB);

        expect(Buffer.byteLength(leafA, 'utf8')).toBeLessThanOrEqual(SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES);
        expect(Buffer.byteLength(leafB, 'utf8')).toBeLessThanOrEqual(SCAN_CLEANUP_OUTPUT_LEAF_MAX_BYTES);
        expect(leafA).toMatch(/…-[a-f\d]{12} — cleaned\.pdf$/u);
        expect(leafB).toMatch(/…-[a-f\d]{12} — cleaned\.pdf$/u);
        expect(leafA).not.toBe(leafB);
        expect(basename(repeatedPathA)).toBe(leafA);

        await Promise.all([
            writeFile(pathA, 'generated A'),
            writeFile(pathB, 'generated B'),
            writeFile(repeatedPathA, 'generated A again'),
        ]);
        await expect(Promise.all([
            stat(pathA),
            stat(pathB),
            stat(repeatedPathA),
        ])).resolves.toHaveLength(3);
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
            isOutputLive: path => path === openPdf,
            nowMs,
        })).resolves.toBe(1);
        await expect(stat(stale)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(stat(open)).resolves.toBeDefined();
        await expect(stat(fresh)).resolves.toBeDefined();
    });

    it('aggregates main-owned output liveness across two WebContents', async () => {
        const appTempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-owners-test-'));
        tempDirs.push(appTempDir);
        const root = getScanCleanupOutputRoot(appTempDir);
        const first = join(root, 'first');
        const second = join(root, 'second');
        const orphan = join(root, 'orphan');
        await Promise.all([
            first,
            second,
            orphan,
        ].map(path => mkdir(path, {recursive: true})));
        const firstPdf = join(first, 'first — cleaned.pdf');
        const secondPdf = join(second, 'second — cleaned.pdf');
        await Promise.all([
            writeFile(firstPdf, 'first'),
            writeFile(secondPdf, 'second'),
            writeFile(join(orphan, 'orphan — cleaned.pdf'), 'orphan'),
        ]);
        const nowMs = Date.now();
        const oldSeconds = (nowMs - SCAN_CLEANUP_OUTPUT_MAX_AGE_MS - 1_000) / 1_000;
        await Promise.all([
            utimes(first, oldSeconds, oldSeconds),
            utimes(second, oldSeconds, oldSeconds),
            utimes(orphan, oldSeconds, oldSeconds),
        ]);
        await Promise.all([
            setWorkingCopyOriginalPath('/working/first.pdf', firstPdf, 101, {deferOriginalFileExpectation: true}),
            setWorkingCopyOriginalPath('/working/second.pdf', secondPdf, 202, {deferOriginalFileExpectation: true}),
        ]);

        await expect(pruneScanCleanupGeneratedOutputs({
            appTempDir,
            isOutputLive: isWorkingCopyOriginalPathRegistered,
            nowMs,
        })).resolves.toBe(1);
        await expect(stat(first)).resolves.toBeDefined();
        await expect(stat(second)).resolves.toBeDefined();
        await expect(stat(orphan)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('rechecks main liveness before deleting when an output opens during pruning', async () => {
        const appTempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-output-open-race-test-'));
        tempDirs.push(appTempDir);
        const root = getScanCleanupOutputRoot(appTempDir);
        const candidate = join(root, 'candidate');
        await mkdir(candidate, {recursive: true});
        const candidatePdf = join(candidate, 'candidate — cleaned.pdf');
        await writeFile(candidatePdf, 'candidate');
        const nowMs = Date.now();
        const oldSeconds = (nowMs - SCAN_CLEANUP_OUTPUT_MAX_AGE_MS - 1_000) / 1_000;
        await utimes(candidate, oldSeconds, oldSeconds);
        let initialCheck = true;
        let registration: Promise<void> | null = null;

        await expect(pruneScanCleanupGeneratedOutputs({
            appTempDir,
            isOutputLive: outputPath => {
                const liveAtCheckStart = isWorkingCopyOriginalPathRegistered(outputPath);
                if (initialCheck) {
                    initialCheck = false;
                    registration = setWorkingCopyOriginalPath(
                        '/working/newly-opened.pdf',
                        outputPath,
                        303,
                        {deferOriginalFileExpectation: true},
                    );
                }
                return liveAtCheckStart;
            },
            nowMs,
        })).resolves.toBe(0);
        await registration;
        await expect(stat(candidate)).resolves.toBeDefined();
    });
});
