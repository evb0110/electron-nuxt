import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createHash} from 'node:crypto';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';

const mocks = vi.hoisted(() => ({
    clearWorkingCopySearchArtifacts: vi.fn(),
    copyFile: vi.fn(),
    cp: vi.fn(),
    createReadStream: vi.fn(),
    ensureWorkingCopyDirectory: vi.fn<(path: string, senderId?: number) => Promise<boolean>>(),
    getWorkingCopyOriginalPath: vi.fn(),
    lstatSync: vi.fn<(path: string) => { isSymbolicLink: () => boolean; }>(),
    open: vi.fn(),
    originalPathSaveBaseMatches: vi.fn(),
    realpathSync: vi.fn<(path: string) => string>(),
    readFile: vi.fn(),
    rebindDocumentTextCatalogRevision: vi.fn(),
    refreshWorkingCopyOriginalFileExpectation: vi.fn(),
    markWorkingCopyContentChanged: vi.fn(),
    removeResultFile: vi.fn(),
    rename: vi.fn(),
    resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(),
    resolveAllowedWritePath: vi.fn<(path: string) => Promise<string | null>>(),
    rm: vi.fn(),
    transitionWorkingCopyContentRevision: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn(),
}));

vi.mock('fs', () => ({
    constants: {COPYFILE_FICLONE: 2},
    createReadStream: (...args: unknown[]) => mocks.createReadStream(...args),
    lstatSync: (path: string) => mocks.lstatSync(path),
    realpathSync: (path: string) => mocks.realpathSync(path),
}));

vi.mock('fs/promises', () => ({
    copyFile: mocks.copyFile,
    cp: mocks.cp,
    open: mocks.open,
    readFile: mocks.readFile,
    rename: mocks.rename,
    rm: mocks.rm,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
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

vi.mock('@electron/file-access/documentRevisionStore', () => ({
    markWorkingCopyContentChanged: (...args: unknown[]) => mocks.markWorkingCopyContentChanged(...args),
    transitionWorkingCopyContentRevision: (...args: unknown[]) => mocks.transitionWorkingCopyContentRevision(...args),
}));
vi.mock('@electron/file-access/workingCopyMutationQueue', () => ({
    clearWorkingCopySearchArtifacts: (...args: unknown[]) => mocks.clearWorkingCopySearchArtifacts(...args),
    enqueueWorkingCopyMutation: async (_path: string, mutation: () => Promise<unknown>) => mutation(),
}));
vi.mock('@electron/file-access/documentMutationGuards', () => ({
    assertQueuedWorkingCopyMutationPreconditions: vi.fn(),
    assertWorkingCopyMutationAllowed: vi.fn(),
    normalizeExpectedDocumentRevisionToken: (options?: { expectedDocumentRevisionToken?: string | null; } | null) =>
        options?.expectedDocumentRevisionToken?.trim() ?? null,
}));

vi.mock('@electron/features/documents/main/originalPathSaveBaseMatches', () => ({originalPathSaveBaseMatches: mocks.originalPathSaveBaseMatches}));

vi.mock('@electron/ocr/documentTextCatalog', () => ({rebindDocumentTextCatalogRevision: (...args: unknown[]) => mocks.rebindDocumentTextCatalogRevision(...args)}));

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
    const resultBytes = Buffer.from('verified OCR result bytes');
    const resultSha256 = createHash('sha256').update(resultBytes).digest('hex');
    const sourceRevisionToken = 'revision-before-ocr' as TDocumentRevisionToken;
    let store: TPendingResultFileStore | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.copyFile.mockResolvedValue(undefined);
        mocks.cp.mockResolvedValue(undefined);
        mocks.createReadStream.mockReturnValue((async function* () {
            yield resultBytes;
        })());
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
        mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), {code: 'ENOENT'}));
        mocks.rebindDocumentTextCatalogRevision.mockResolvedValue(undefined);
        mocks.refreshWorkingCopyOriginalFileExpectation.mockReturnValue(undefined);
        mocks.markWorkingCopyContentChanged.mockResolvedValue(undefined);
        mocks.removeResultFile.mockResolvedValue(true);
        mocks.rename.mockResolvedValue(undefined);
        mocks.resolveAllowedReadPath.mockResolvedValue(canonicalOcrPath);
        mocks.resolveAllowedWritePath.mockResolvedValue(resolvedWorkingCopyPath);
        mocks.rm.mockResolvedValue(undefined);
        mocks.transitionWorkingCopyContentRevision.mockImplementation(async (
            _path: string,
            _reason: string,
            mutation: (revision: {token: string}) => Promise<void>,
        ) => {
            await mutation({token: 'revision-after-ocr'});
            return {token: 'revision-after-ocr'};
        });
        mocks.unlink.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);

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
        store?.track('42:ocr-1', 'ocr-1', 42, rendererOcrPath, resultSha256, true);

        await expect(handleReplaceWorkingCopyFromPath(
            ownerContext,
            workingCopyPath,
            rendererOcrPath,
            {expectedDocumentRevisionToken: sourceRevisionToken},
        )).resolves.toBe(true);

        expect(mocks.transitionWorkingCopyContentRevision).toHaveBeenCalledWith(
            resolvedWorkingCopyPath,
            'ocr-apply',
            expect.any(Function),
            ownerContext.senderId,
        );
        expect(mocks.rebindDocumentTextCatalogRevision).toHaveBeenCalledWith(
            resolvedWorkingCopyPath,
            sourceRevisionToken,
            'revision-after-ocr',
        );

        expect(mocks.copyFile).toHaveBeenNthCalledWith(
            2,
            canonicalOcrPath,
            expect.stringMatching(/\/private\/var\/folders\/app\/T\/evb-viewer\/pdf-work-1\/\.book\.pdf\.\d+\..+\.tmp$/u),
            2,
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
            {expectedDocumentRevisionToken: sourceRevisionToken},
        )).rejects.toThrow('Invalid source path: OCR result is not owned by this renderer');

        expect(mocks.copyFile).not.toHaveBeenCalled();
        expect(mocks.rename).not.toHaveBeenCalled();
    });
});
