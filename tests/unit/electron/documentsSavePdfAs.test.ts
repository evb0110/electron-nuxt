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
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
    showSaveDialog: vi.fn(),
    updateRecentFilesMenu: vi.fn(),
    addRecentFile: vi.fn(),
    allowOpenPath: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(),
    setWorkingCopyOriginalPath: vi.fn<(workingPath: string, originalPath: string) => void>(),
    workingCopyMap: new Map<string, string>(),
    atomicReplace: vi.fn(),
    makeSiblingTempPath: vi.fn((targetPath: string) => `${targetPath}.tmp`),
}));

vi.mock('electron', () => ({
    BrowserWindow: {
        fromWebContents: vi.fn(() => null),
        getAllWindows: vi.fn(() => []),
        getFocusedWindow: vi.fn(() => null),
    },
    dialog: {
        showOpenDialog: vi.fn(),
        showSaveDialog: (...args: unknown[]) => mocks.showSaveDialog(...args),
    },
    shell: { showItemInFolder: vi.fn() },
}));

vi.mock('@electron/image/pdfConversion', () => ({
    buildCombinedPdfOutputPath: vi.fn(),
    createPdfFromInputPaths: vi.fn(),
    isDjvuPath: vi.fn(() => false),
    isPdfPath: vi.fn((path: string) => path.toLowerCase().endsWith('.pdf')),
    isSupportedOpenPath: vi.fn(() => true),
    SUPPORTED_IMAGE_EXTENSIONS: ['.png'],
}));

vi.mock('@electron/menu', () => ({
    refreshMenu: vi.fn(),
    updateRecentFilesMenu: (...args: unknown[]) => mocks.updateRecentFilesMenu(...args),
}));

vi.mock('@electron/recentFiles', () => ({addRecentFile: (...args: unknown[]) => mocks.addRecentFile(...args)}));
vi.mock('@electron/ipc/docxExportPaths', () => ({allowDocxWritePath: vi.fn()}));
vi.mock('@electron/djvu/exportPaths', () => ({allowDjvuWritePath: vi.fn()}));
vi.mock('@electron/ipc/workingCopyCreation', () => ({
    createWorkingCopy: vi.fn(),
    createWorkingCopyFromData: vi.fn(),
    createWorkingCopyFromPath: vi.fn(),
    ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args),
}));
vi.mock('@electron/ipc/workingCopyStore', () => ({
    getWorkingCopyOriginalPath: (...args: unknown[]) => mocks.getWorkingCopyOriginalPath(...args),
    isKnownWorkingCopyOriginalPath: vi.fn(() => false),
    setWorkingCopyOriginalPath: (...args: [string, string]) => mocks.setWorkingCopyOriginalPath(...args),
}));
vi.mock('@electron/ipc/openPathCapabilities', () => ({
    allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args),
    allowOpenPaths: vi.fn(),
    logRejectedOpenPath: vi.fn(),
    requireOpenPath: vi.fn((path: string) => path),
}));
vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedReadPath: vi.fn(async () => null)}));
vi.mock('@electron/i18n', () => ({te: (key: string) => key}));
vi.mock('@electron/utils/logger', () => ({ createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}) }));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: (...args: unknown[]) => mocks.atomicReplace(...args),
    makeSiblingTempPath: (...args: [string]) => mocks.makeSiblingTempPath(...args),
}));

describe('handleSavePdfAs', () => {
    let tempRoot = '';

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.workingCopyMap.clear();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-save-pdf-as-test-'));
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.setWorkingCopyOriginalPath.mockImplementation((workingPath, originalPath) => {
            mocks.workingCopyMap.set(workingPath, originalPath);
        });
        mocks.atomicReplace.mockImplementation(async (sourcePath: string, targetPath: string) => {
            await writeFile(targetPath, await readFile(sourcePath));
            await unlink(sourcePath);
        });
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('writes through a sibling temp path before replacing the selected PDF path', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        writeFileSync(workingPath, 'new-pdf');
        writeFileSync(targetPath, 'old-pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: targetPath,
        });

        const { handleSavePdfAs } = await import('@electron/features/documents/main/documentSaveDialogHandlers');

        await expect(handleSavePdfAs({sender: {}} as never, workingPath)).resolves.toBe(targetPath);

        expect(mocks.makeSiblingTempPath).toHaveBeenCalledWith(targetPath);
        expect(mocks.atomicReplace).toHaveBeenCalledWith(tempPath, targetPath);
        expect(readFileSyncUtf8(targetPath)).toBe('new-pdf');
        expect(existsSync(tempPath)).toBe(false);
        expect(mocks.workingCopyMap.get(workingPath)).toBe(targetPath);
        expect(mocks.allowOpenPath).toHaveBeenCalledWith(targetPath, {});
        expect(mocks.addRecentFile).toHaveBeenCalledWith(targetPath);
        expect(mocks.updateRecentFilesMenu).toHaveBeenCalled();
        expect(
            mocks.atomicReplace.mock.invocationCallOrder[0]!,
        ).toBeLessThan(mocks.allowOpenPath.mock.invocationCallOrder[0]!);
    });

    it('cleans the sibling temp path and preserves the existing target when replacement fails', async () => {
        const workingPath = join(tempRoot, 'working.pdf');
        const originalPath = join(tempRoot, 'original.pdf');
        const targetPath = join(tempRoot, 'saved.pdf');
        const tempPath = `${targetPath}.tmp`;
        writeFileSync(workingPath, 'new-pdf');
        writeFileSync(targetPath, 'old-pdf');
        mocks.getWorkingCopyOriginalPath.mockReturnValue({originalPath});
        mocks.showSaveDialog.mockResolvedValue({
            canceled: false,
            filePath: targetPath,
        });
        mocks.atomicReplace.mockRejectedValue(new Error('replace failed'));

        const { handleSavePdfAs } = await import('@electron/features/documents/main/documentSaveDialogHandlers');

        await expect(handleSavePdfAs({sender: {}} as never, workingPath))
            .rejects
            .toThrow('replace failed');

        expect(readFileSyncUtf8(targetPath)).toBe('old-pdf');
        expect(existsSync(tempPath)).toBe(false);
        expect(mocks.workingCopyMap.has(workingPath)).toBe(false);
        expect(mocks.allowOpenPath).not.toHaveBeenCalled();
        expect(mocks.addRecentFile).not.toHaveBeenCalled();
        expect(mocks.updateRecentFilesMenu).not.toHaveBeenCalled();
    });
});

function readFileSyncUtf8(path: string) {
    return readFileSync(path, 'utf8');
}
