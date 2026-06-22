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
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import {
    copyFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
    analyzePdfConformanceFile: vi.fn(),
    validatePdfFile: vi.fn(),
    runNativeToolCommand: vi.fn(),
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.optimized`),
}));

vi.mock('@electron/features/documents/main/pdfConformance', () => ({
    analyzePdfConformanceFile: (...args: unknown[]) => mocks.analyzePdfConformanceFile(...args),
    validatePdfFile: (...args: unknown[]) => mocks.validatePdfFile(...args),
}));
vi.mock('@electron/native-tools/getNativeToolPaths', () => ({ getNativeToolPaths: () => ({ qpdf: '/native/qpdf' }) }));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({ runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args) }));
vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}) }));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));

describe('pdfSaveAsOptimization', () => {
    let tempRoot = '';

    beforeEach(() => {
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-pdf-save-as-optimization-test-'));
        mocks.analyzePdfConformanceFile.mockResolvedValue({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
        mocks.validatePdfFile.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await copyFile(sourcePath, targetPath);
            await unlink(sourcePath);
        });
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('does nothing when lossless optimization is not enabled', async () => {
        const tempPath = join(tempRoot, 'document.pdf');
        writeFileSync(tempPath, 'original-pdf');
        const { optimizePdfForSaveAs } = await import('@electron/features/documents/main/pdfSaveAsOptimization');

        await expect(optimizePdfForSaveAs(tempPath)).resolves.toBeNull();

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(readFileSyncUtf8(tempPath)).toBe('original-pdf');
    });

    it('keeps valid smaller qpdf output and replaces the temp PDF', async () => {
        const tempPath = join(tempRoot, 'document.pdf');
        const optimizedPath = `${tempPath}.optimized`;
        writeFileSync(tempPath, 'original-pdf');
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await writeFile(optimizedPath, 'small');
        });
        const { optimizePdfForSaveAs } = await import('@electron/features/documents/main/pdfSaveAsOptimization');

        await expect(optimizePdfForSaveAs(tempPath, { optimizeLossless: true }))
            .resolves
            .toMatchObject({ isValid: true });

        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/qpdf',
            [
                '--stream-data=preserve',
                '--object-streams=generate',
                tempPath,
                optimizedPath,
            ],
            expect.objectContaining({ commandLabel: 'qpdf(save-as-optimize)' }),
        );
        expect(mocks.validatePdfFile).toHaveBeenCalledWith(optimizedPath);
        expect(mocks.atomicReplace).toHaveBeenCalledWith(optimizedPath, tempPath);
        expect(readFileSyncUtf8(tempPath)).toBe('small');
        expect(existsSync(optimizedPath)).toBe(false);
    });

    it('discards qpdf output that is not smaller', async () => {
        const tempPath = join(tempRoot, 'document.pdf');
        const optimizedPath = `${tempPath}.optimized`;
        writeFileSync(tempPath, 'tiny');
        mocks.runNativeToolCommand.mockImplementation(async () => {
            await writeFile(optimizedPath, 'larger-pdf');
        });
        const { optimizePdfForSaveAs } = await import('@electron/features/documents/main/pdfSaveAsOptimization');

        await expect(optimizePdfForSaveAs(tempPath, { optimizeLossless: true })).resolves.toBeNull();

        expect(mocks.validatePdfFile).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).not.toHaveBeenCalled();
        expect(readFileSyncUtf8(tempPath)).toBe('tiny');
        expect(existsSync(optimizedPath)).toBe(false);
    });

    it('skips PDFs where rewriting can alter document semantics', async () => {
        const tempPath = join(tempRoot, 'signed.pdf');
        writeFileSync(tempPath, 'signed-pdf');
        mocks.analyzePdfConformanceFile.mockResolvedValue({
            isSigned: true,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: false,
            saveRestrictions: ['signed'],
        });
        const { optimizePdfForSaveAs } = await import('@electron/features/documents/main/pdfSaveAsOptimization');

        await expect(optimizePdfForSaveAs(tempPath, { optimizeLossless: true })).resolves.toBeNull();

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(readFileSyncUtf8(tempPath)).toBe('signed-pdf');
    });
});

function readFileSyncUtf8(path: string) {
    return readFileSync(path, 'utf8');
}
