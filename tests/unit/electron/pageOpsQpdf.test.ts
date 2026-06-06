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

type TRunCommandOptionsExpectation = { allowedExitCodes?: number[] };

async function readQpdfArgFile(args: string[]) {
    const argFile = args[0];
    if (!argFile?.startsWith('@')) {
        throw new Error(`Expected qpdf arg file invocation, got ${JSON.stringify(args)}`);
    }

    return (await readFile(argFile.slice(1), 'utf8')).split('\n');
}

vi.mock('node:crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof NodeCrypto>();
    return {
        ...actual,
        randomUUID: () => randomUuidMock(),
    };
});
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => runNativeToolCommandMock(...args)}));
vi.mock('@electron/native-tools/getNativeToolPaths', () => ({getNativeToolPaths: () => ({ qpdf: '/mock/qpdf' })}));
vi.mock('@electron/ipc/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => ensureWorkingCopyDirectoryMock(...args)}));
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
    });

    it('rejects empty qpdf output and removes an empty destination placeholder', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const srcPath = join(workDir, 'source.pdf');
        const destPath = join(workDir, 'extract.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');

        try {
            await writeFile(srcPath, '%PDF-1.7\n');
            await writeFile(destPath, '');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs.at(-1)).toBe(tempOutputPath);
                await writeFile(tempOutputPath, new Uint8Array());
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
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('writes qpdf output to a sibling temp PDF before replacing the destination', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const srcPath = join(workDir, 'source.pdf');
        const destPath = join(workDir, 'extract.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');

        try {
            await writeFile(srcPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs.at(-1)).toBe(tempOutputPath);
                await writeFile(tempOutputPath, '%PDF-1.7\nextracted');
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

        try {
            await writeFile(srcPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (
                _qpdf,
                args: string[],
                options: TRunCommandOptionsExpectation,
            ) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs.at(-1)).toBe(tempOutputPath);
                expect(options.allowedExitCodes).toEqual([
                    0,
                    3,
                ]);
                await writeFile(tempOutputPath, '%PDF-1.7\nrepaired extraction');
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
    });

    it('recovers the working-copy directory before writing mutation output beside it', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                const qpdfArgs = await readQpdfArgFile(args);
                expect(qpdfArgs.at(-1)).toBe(tempOutputPath);
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
});
