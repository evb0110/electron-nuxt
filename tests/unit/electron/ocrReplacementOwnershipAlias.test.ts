import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    copyFile: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn<(path: string, senderId?: number) => Promise<boolean>>(),
    getWorkingCopyOriginalPath: vi.fn(),
    lstatSync: vi.fn<(path: string) => { isSymbolicLink: () => boolean; }>(),
    open: vi.fn(),
    originalPathSaveBaseMatches: vi.fn(),
    realpathSync: vi.fn<(path: string) => string>(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    removeResultFile: vi.fn(),
    rename: vi.fn(),
    resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(),
    resolveAllowedWritePath: vi.fn<(path: string) => Promise<string | null>>(),
    unlink: vi.fn(),
}));

vi.mock('fs', () => ({
    lstatSync: (path: string) => mocks.lstatSync(path),
    realpathSync: (path: string) => mocks.realpathSync(path),
}));

vi.mock('fs/promises', () => ({
    copyFile: mocks.copyFile,
    open: mocks.open,
    rename: mocks.rename,
    unlink: mocks.unlink,
}));

vi.mock('@electron/utils/pathValidator', () => ({
    resolveAllowedReadPath: mocks.resolveAllowedReadPath,
    resolveAllowedWritePath: mocks.resolveAllowedWritePath,
}));

vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: mocks.ensureWorkingCopyDirectory}));

vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyOriginalPath: mocks.getWorkingCopyOriginalPath,
    normalizePathForLookup: (path: string) => path.trim(),
    refreshWorkingCopyOriginalFileExpectation: mocks.refreshWorkingCopyOriginalFileExpectation,
}));

vi.mock('@electron/features/documents/main/originalPathSaveBaseMatches', () => ({originalPathSaveBaseMatches: mocks.originalPathSaveBaseMatches}));

vi.mock('@electron/file-access/docxExportPaths', () => ({consumeAllowedDocxWritePath: vi.fn(() => true)}));

const { createPendingResultFileStore } = await import('@electron/ocr/createPendingResultFileStore');
const { handleReplaceWorkingCopyFromPath } = await import('@electron/features/documents/main/documentFileWriteHandlers');

type TPendingResultFileStore = ReturnType<typeof createPendingResultFileStore>;

describe('OCR replacement ownership path aliases', () => {
    const ownerContext = {senderId: 42};
    const otherContext = {senderId: 43};
    const workingCopyPath = '/var/folders/app/T/evb-viewer/pdf-work-1/book.pdf';
    const resolvedWorkingCopyPath = '/private/var/folders/app/T/evb-viewer/pdf-work-1/book.pdf';
    const rendererOcrPath = '/var/folders/app/T/evb-viewer/ocr-1-merged.pdf';
    const canonicalOcrPath = '/private/var/folders/app/T/evb-viewer/ocr-1-merged.pdf';
    let store: TPendingResultFileStore | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        mocks.getWorkingCopyOriginalPath.mockReturnValue(null);
        mocks.lstatSync.mockReturnValue({isSymbolicLink: () => false});
        mocks.open.mockResolvedValue({
            close: vi.fn(async () => undefined),
            sync: vi.fn(async () => undefined),
        });
        mocks.originalPathSaveBaseMatches.mockResolvedValue(true);
        mocks.realpathSync.mockImplementation((path: string) => path.replace(
            /^\/var\/folders\//u,
            '/private/var/folders/',
        ));
        mocks.refreshWorkingCopyOriginalFileExpectation.mockReturnValue(undefined);
        mocks.removeResultFile.mockResolvedValue(true);
        mocks.rename.mockResolvedValue(undefined);
        mocks.resolveAllowedReadPath.mockResolvedValue(canonicalOcrPath);
        mocks.resolveAllowedWritePath.mockResolvedValue(resolvedWorkingCopyPath);
        mocks.unlink.mockResolvedValue(undefined);

        store = createPendingResultFileStore({
            logger: {
                debug: vi.fn(),
                error: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
            },
            removeResultFile: mocks.removeResultFile,
            ttlMs: 60_000,
        });
    });

    afterEach(async () => {
        await store?.shutdown();
        store = null;
    });

    it('allows the owning renderer to replace from a macOS /var alias but rejects other renderers', async () => {
        store?.track('42:ocr-1', 'ocr-1', 42, rendererOcrPath, true);

        await expect(handleReplaceWorkingCopyFromPath(
            ownerContext,
            workingCopyPath,
            rendererOcrPath,
        )).resolves.toBe(true);

        expect(mocks.copyFile).toHaveBeenCalledWith(
            canonicalOcrPath,
            expect.stringMatching(/\/private\/var\/folders\/app\/T\/evb-viewer\/pdf-work-1\/\.book\.pdf\.\d+\..+\.tmp$/u),
        );
        expect(mocks.rename).toHaveBeenCalledWith(
            expect.stringMatching(/\/private\/var\/folders\/app\/T\/evb-viewer\/pdf-work-1\/\.book\.pdf\.\d+\..+\.tmp$/u),
            resolvedWorkingCopyPath,
        );

        mocks.copyFile.mockClear();
        mocks.rename.mockClear();

        await expect(handleReplaceWorkingCopyFromPath(
            otherContext,
            workingCopyPath,
            rendererOcrPath,
        )).rejects.toThrow('Invalid source path: OCR result is not owned by this renderer');

        expect(mocks.copyFile).not.toHaveBeenCalled();
        expect(mocks.rename).not.toHaveBeenCalled();
    });
});
