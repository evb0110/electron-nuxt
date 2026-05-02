import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    rm,
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const randomUuidMock = vi.hoisted(() => vi.fn(() => 'fixed-output-id'));
const runNativeToolCommandMock = vi.hoisted(() => vi.fn());
const ensureWorkingCopyDirectoryMock = vi.hoisted(() => vi.fn());

vi.mock('node:crypto', () => ({ randomUUID: () => randomUuidMock() }));
vi.mock('@electron/native-tools/exec', () => ({runNativeToolCommand: (...args: unknown[]) => runNativeToolCommandMock(...args)}));
vi.mock('@electron/native-tools/paths', () => ({getNativeToolPaths: () => ({ qpdf: '/mock/qpdf' })}));
vi.mock('@electron/ipc/workingCopy', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => ensureWorkingCopyDirectoryMock(...args)}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

describe('page-ops qpdf extract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ensureWorkingCopyDirectoryMock.mockResolvedValue(false);
    });

    it('rejects empty qpdf output and removes an empty destination placeholder', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const srcPath = join(workDir, 'source.pdf');
        const destPath = join(workDir, 'extract.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');

        try {
            await writeFile(srcPath, '%PDF-1.7\n');
            await writeFile(destPath, '');
            runNativeToolCommandMock.mockImplementationOnce(async () => {
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
                expect(args.at(-1)).toBe(tempOutputPath);
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
});

describe('page-ops qpdf working-copy mutations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ensureWorkingCopyDirectoryMock.mockResolvedValue(false);
    });

    it('recovers the working-copy directory before writing mutation output beside it', async () => {
        const workDir = await mkdtemp(join(tmpdir(), 'page-ops-qpdf-'));
        const workingCopyPath = join(workDir, 'work.pdf');
        const tempOutputPath = join(workDir, 'tmp-fixed-output-id.pdf');

        try {
            await writeFile(workingCopyPath, '%PDF-1.7\n');
            runNativeToolCommandMock.mockImplementationOnce(async (_qpdf, args: string[]) => {
                expect(args.at(-1)).toBe(tempOutputPath);
                await writeFile(tempOutputPath, '%PDF-1.7\nrotated');
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            });

            const { rotatePages } = await import('@electron/features/page-ops/main/qpdf');

            await rotatePages(workingCopyPath, [1], 90);

            expect(ensureWorkingCopyDirectoryMock).toHaveBeenCalledWith(workingCopyPath);
            await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('%PDF-1.7\nrotated');
            await expect(stat(tempOutputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(workDir, {
                recursive: true,
                force: true,
            });
        }
    });
});
