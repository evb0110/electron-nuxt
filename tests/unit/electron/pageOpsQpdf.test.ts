import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type * as NodeCrypto from 'node:crypto';

const randomUuidMock = vi.hoisted(() => vi.fn(() => 'fixed-output-id'));
const runNativeToolCommandMock = vi.hoisted(() => vi.fn());
const ensureWorkingCopyDirectoryMock = vi.hoisted(() => vi.fn());
const ensureWorkingCopyMaterializedMock = vi.hoisted(() => vi.fn());
const getWorkingCopyBackingEntryMock = vi.hoisted(() => vi.fn());

interface IQpdfRunCommandOptionsExpectation { allowedExitCodes?: number[] }

async function readQpdfArgFile(args: string[]) {
    const argFile = args[0];
    if (!argFile?.startsWith('@')) {
        throw new Error(`Expected qpdf arg file invocation, got ${JSON.stringify(args)}`);
    }

    return (await readFile(argFile.slice(1), 'utf8')).split('\n');
}

function expectManagedQpdfOutputPath(qpdfArgs: string[], forbiddenPath?: string) {
    const outputPath = qpdfArgs.at(-1);
    expect(outputPath).toEqual(expect.stringContaining('qpdfOutput-'));
    if (forbiddenPath !== undefined) {
        expect(outputPath).not.toBe(forbiddenPath);
    }
    return outputPath as string;
}

vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof NodeCrypto>();
    return {
        ...actual,
        randomUUID: () => randomUuidMock(),
    };
});
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => runNativeToolCommandMock(...args)}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({ qpdf: '/mock/qpdf' })}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => ensureWorkingCopyDirectoryMock(...args)}));
vi.mock('@electron/file-access/workingCopyMaterialization', () => ({ensureWorkingCopyMaterialized: (...args: unknown[]) => ensureWorkingCopyMaterializedMock(...args)}));
vi.mock('@electron/file-access/workingCopyStore', () => ({getWorkingCopyBackingEntry: (...args: unknown[]) => getWorkingCopyBackingEntryMock(...args)}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

describe('page-ops qpdf extract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ensureWorkingCopyDirectoryMock.mockResolvedValue(true);
        ensureWorkingCopyMaterializedMock.mockImplementation(async (path: string) => ({
            logicalRef: path,
            physicalWorkingCopyPath: path,
            sourceFingerprint: '',
        }));
        getWorkingCopyBackingEntryMock.mockReturnValue(null);
    });

    it('rejects empty qpdf output and removes an empty destination placeholder', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const srcPath = join(workDir, 'source.pdf');
        const destPath = join(workDir, 'extract.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');
        let qpdfOutputPath = '';

        try {
            await writeFile(srcPath, '%PDF-1.7\n');
            await writeFile(destPath, '');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                qpdfOutputPath = expectManagedQpdfOutputPath(qpdfArgs, tempOutputPath);
                await writeFile(qpdfOutputPath, new Uint8Array());
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { extractPages } = await import('@electron/features/page-ops/main/qpdf');

            await expect(extractPages(srcPath, destPath, [
                1,
                2,
            ])).rejects.toThrow('Extracting pages failed: qpdf produced an empty PDF');

            await expect(stat(destPath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(tempOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(qpdfOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('writes qpdf output to managed scratch before replacing the destination', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const srcPath = join(workDir, 'source.pdf');
        const destPath = join(workDir, 'extract.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');
        let qpdfOutputPath = '';

        try {
            await writeFile(srcPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                qpdfOutputPath = expectManagedQpdfOutputPath(qpdfArgs, tempOutputPath);
                await writeFile(qpdfOutputPath, '%PDF-1.7\nextracted');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { extractPages } = await import('@electron/features/page-ops/main/qpdf');

            await extractPages(srcPath, destPath, [1]);

            await expect(readFile(destPath, 'utf8')).resolves.toBe('%PDF-1.7\nextracted');
            await expect(stat(tempOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(qpdfOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('demand-materializes lazy-original input before page extraction', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const srcPath = join(workDir, 'source.pdf');
        const destPath = join(workDir, 'extract.pdf');
        getWorkingCopyBackingEntryMock.mockReturnValue({
            backingState: 'lazy-original',
            registrationId: 3,
        });

        try {
            await writeFile(srcPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs.slice(0, 4)).toEqual([
                    srcPath,
                    '--pages',
                    srcPath,
                    '1',
                ]);
                await writeFile(qpdfArgs.at(-1)!, '%PDF-1.7\nextracted');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { extractPages } = await import('@electron/features/page-ops/main/qpdf');

            await extractPages(srcPath, destPath, [1], {senderWebContentsId: 12});

            expect(ensureWorkingCopyMaterializedMock).toHaveBeenCalledWith(srcPath, {
                ownerWebContentsId: 12,
                reason: 'page-operation',
            });
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('does not pass user-selected destination paths to qpdf before saving the extracted PDF', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const srcPath = join(workDir, 'source.pdf');
        const destPath = join(workDir, 'страницы 1-2.pdf');

        try {
            await writeFile(srcPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs).not.toContain(destPath);
                const qpdfOutputPath = expectManagedQpdfOutputPath(qpdfArgs);
                await writeFile(qpdfOutputPath, '%PDF-1.7\nunicode destination extraction');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { extractPages } = await import('@electron/features/page-ops/main/qpdf');

            await extractPages(srcPath, destPath, [
                1,
                2,
            ]);

            await expect(readFile(destPath, 'utf8')).resolves.toBe('%PDF-1.7\nunicode destination extraction');
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('accepts qpdf warning-only extraction when a non-empty PDF was written', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const srcPath = join(workDir, 'source.pdf');
        const destPath = join(workDir, 'extract.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');
        let qpdfOutputPath = '';

        try {
            await writeFile(srcPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (
                _qpdf,
                args: string[],
                options: IQpdfRunCommandOptionsExpectation,
            ) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs).toEqual([
                    srcPath,
                    '--pages',
                    srcPath,
                    '1',
                    '--',
                    expect.stringContaining('qpdfOutput-'),
                ]);
                qpdfOutputPath = qpdfArgs.at(-1) ?? '';
                expect(qpdfOutputPath).not.toBe(tempOutputPath);
                expect(options.allowedExitCodes).toEqual([
                    0,
                    3,
                ]);
                await writeFile(qpdfOutputPath, '%PDF-1.7\nrepaired extraction');
                return {
                    exitCode: 3,
                    stdout: '',
                    stderr: 'WARNING: xref entry for the xref stream itself is missing\nqpdf: operation succeeded with warnings',
                };
            });

            const { extractPages } = await import('@electron/features/page-ops/main/qpdf');

            await extractPages(srcPath, destPath, [1]);

            await expect(readFile(destPath, 'utf8')).resolves.toBe('%PDF-1.7\nrepaired extraction');
            await expect(stat(tempOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(stat(qpdfOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });
});

describe('page-ops qpdf working-copy mutations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ensureWorkingCopyDirectoryMock.mockResolvedValue(true);
        ensureWorkingCopyMaterializedMock.mockImplementation(async (path: string) => ({
            logicalRef: path,
            physicalWorkingCopyPath: path,
            sourceFingerprint: '',
        }));
        getWorkingCopyBackingEntryMock.mockReturnValue(null);
    });

    it('recovers the working-copy directory before writing mutation output beside it', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs).toEqual([
                    workingCopyPath,
                    '--rotate=+90:1',
                    tempOutputPath,
                ]);
                await writeFile(tempOutputPath, '%PDF-1.7\nrotated');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { rotatePages } = await import('@electron/features/page-ops/main/qpdf');

            await rotatePages(workingCopyPath, [1], 90, 12);

            expect(ensureWorkingCopyDirectoryMock).toHaveBeenCalledWith(workingCopyPath, 12);
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('%PDF-1.7\nrotated');
            await expect(stat(tempOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('demand-materializes lazy-original input before qpdf mutation', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');
        getWorkingCopyBackingEntryMock.mockReturnValue({
            backingState: 'lazy-original',
            registrationId: 1,
        });

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs).toEqual([
                    workingCopyPath,
                    '--rotate=+90:1',
                    tempOutputPath,
                ]);
                await writeFile(tempOutputPath, '%PDF-1.7\nrotated');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { rotatePages } = await import('@electron/features/page-ops/main/qpdf');

            await rotatePages(workingCopyPath, [1], 90, 12);

            expect(ensureWorkingCopyMaterializedMock).toHaveBeenCalledWith(workingCopyPath, {
                ownerWebContentsId: 12,
                reason: 'page-operation',
            });
            expect(ensureWorkingCopyDirectoryMock).not.toHaveBeenCalled();
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps cloned page-operation paths unchanged', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');
        getWorkingCopyBackingEntryMock.mockReturnValue({
            backingState: 'cloned',
            registrationId: 2,
        });

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs[0]).toBe(workingCopyPath);
                await writeFile(tempOutputPath, '%PDF-1.7\nrotated');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { rotatePages } = await import('@electron/features/page-ops/main/qpdf');

            await rotatePages(workingCopyPath, [1], 90, 12);

            expect(ensureWorkingCopyMaterializedMock).toHaveBeenCalledOnce();
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('%PDF-1.7\nrotated');
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('uses qpdf page count instead of trusting stale renderer totals for delete ranges', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const workingCopyPath = join(workDir, 'work.pdf');

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockResolvedValueOnce({
                exitCode: 0,
                stdout: '4\n',
                stderr: '',
            });

            const { deletePages } = await import('@electron/features/page-ops/main/qpdf');

            await expect(deletePages(workingCopyPath, [2], 3, 12))
                .rejects.toThrow('Renderer page count is stale');

            expect(runNativeToolCommandMock).toHaveBeenCalledTimes(1);
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('accepts warning-only qpdf page counts', async () => {
        runNativeToolCommandMock.mockResolvedValueOnce({
            exitCode: 3,
            stdout: '4\n',
            stderr: 'WARNING: xref entry for the xref stream itself is missing\nqpdf: operation succeeded with warnings',
        });

        const { getPdfPageCount } = await import('@electron/features/page-ops/main/qpdf');

        await expect(getPdfPageCount('/tmp/warn.pdf')).resolves.toBe(4);
        expect(runNativeToolCommandMock).toHaveBeenCalledWith('/mock/qpdf', [
            '--show-npages',
            '/tmp/warn.pdf',
        ], expect.objectContaining({
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(page-count)',
            timeoutMs: 120_000,
        }));
    });

    it('passes cancellation options to qpdf page count commands', async () => {
        const controller = new AbortController();
        runNativeToolCommandMock.mockResolvedValueOnce({
            exitCode: 0,
            stdout: '4\n',
            stderr: '',
        });

        const { getPdfPageCount } = await import('@electron/features/page-ops/main/qpdf');

        await expect(getPdfPageCount('/tmp/cancelable.pdf', {
            signal: controller.signal,
            cancelGroup: 'working-copy-mutation:test',
        })).resolves.toBe(4);

        expect(runNativeToolCommandMock).toHaveBeenCalledWith('/mock/qpdf', [
            '--show-npages',
            '/tmp/cancelable.pdf',
        ], expect.objectContaining({
            signal: controller.signal,
            cancelGroup: 'working-copy-mutation:test',
        }));
    });

    it('formats delete complements as compact qpdf ranges without prebuilding every page index', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockResolvedValueOnce({
                exitCode: 0,
                stdout: '7\n',
                stderr: '',
            });
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs).toEqual([
                    workingCopyPath,
                    '--pages',
                    workingCopyPath,
                    '1,3,6-7',
                    '--',
                    tempOutputPath,
                ]);
                await writeFile(tempOutputPath, '%PDF-1.7\ndeleted');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { deletePages } = await import('@electron/features/page-ops/main/qpdf');

            await expect(deletePages(workingCopyPath, [
                2,
                4,
                5,
            ], 7, 12)).resolves.toEqual({ pageCount: 4 });

            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('%PDF-1.7\ndeleted');
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('passes cancellation options through page-count and mutation qpdf commands', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');
        const controller = new AbortController();
        const options = {
            signal: controller.signal,
            cancelGroup: 'working-copy-mutation:test',
        };

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockResolvedValueOnce({
                exitCode: 0,
                stdout: '3\n',
                stderr: '',
            });
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs.at(-1)).toBe(tempOutputPath);
                await writeFile(tempOutputPath, '%PDF-1.7\ndeleted');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { deletePages } = await import('@electron/features/page-ops/main/qpdf');

            await expect(deletePages(workingCopyPath, [2], 3, 12, options)).resolves.toEqual({ pageCount: 2 });

            expect(runNativeToolCommandMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining(options));
            expect(runNativeToolCommandMock.mock.calls[1]?.[2]).toEqual(expect.objectContaining(options));
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });
});
