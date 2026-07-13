import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const allowedPathsByOwner = new Map<number, Set<string>>();
    const getOwnerId = (owner: number | { id?: number } | undefined) => (
        typeof owner === 'number' ? owner : owner?.id ?? 0
    );
    return {
        allowedPathsByOwner,
        getOwnerId,
        getRecentFiles: vi.fn(),
        logRejectedOpenPath: vi.fn(),
        handlePdfOpeningGeometry: vi.fn(),
        openInputPaths: vi.fn(),
        showOpenDocumentDialog: vi.fn(),
        logger: {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        },
    };
});

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }));
vi.mock('@electron/te', () => ({ te: (key: string) => key }));
vi.mock('@electron/utils/error', () => ({ getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => mocks.logger }));
vi.mock('@electron/image/pdfConversion', () => ({ isSupportedOpenPath: () => true }));
vi.mock('@electron/image/pdfCombineShared', () => ({PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS: ['.png']}));
vi.mock('@electron/recentFiles', () => ({ getRecentFiles: mocks.getRecentFiles }));
vi.mock('@electron/features/documents/main/openInputPaths.service', () => ({ openInputPaths: mocks.openInputPaths }));
vi.mock('@electron/features/documents/main/nativePdfPreview', () => ({handlePdfOpeningGeometry: mocks.handlePdfOpeningGeometry}));
vi.mock('@electron/features/documents/main/documentDialogCommon', () => ({
    errorWithDetails: (fallbackMessage: string, details: unknown) => (
        details instanceof Error
            ? new Error(`${fallbackMessage}: ${details.message}`)
            : new Error(fallbackMessage)
    ),
    showOpenDocumentDialogForContext: mocks.showOpenDocumentDialog,
}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: (filePath: string, owner?: number | { id?: number }) => {
        const ownerId = mocks.getOwnerId(owner);
        const allowedPaths = mocks.allowedPathsByOwner.get(ownerId) ?? new Set<string>();
        allowedPaths.add(filePath);
        mocks.allowedPathsByOwner.set(ownerId, allowedPaths);
        return filePath;
    },
    logRejectedOpenPath: mocks.logRejectedOpenPath,
    requireOpenPath: (filePath: string, owner?: number | { id?: number }) => {
        const ownerId = mocks.getOwnerId(owner);
        if (!mocks.allowedPathsByOwner.get(ownerId)?.has(filePath)) {
            throw new Error(`Path not allowed: ${filePath}`);
        }
        return filePath;
    },
}));

function createOpenContext(ownerId: number) {
    const sender = {id: ownerId} as Electron.WebContents;
    return {
        sender,
        senderId: ownerId,
    };
}

describe('document direct-open recent authorization', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.allowedPathsByOwner.clear();
        mocks.getRecentFiles.mockResolvedValue([]);
        mocks.handlePdfOpeningGeometry.mockResolvedValue(null);
        mocks.openInputPaths.mockResolvedValue(null);
    });

    it('allows a trusted recent file to open after an Electron restart clears renderer capabilities', async () => {
        const recentPath = '/tmp/restart-recent.pdf';
        mocks.getRecentFiles.mockResolvedValue([{
            originalPath: recentPath,
            fileName: 'restart-recent.pdf',
            timestamp: 1,
            fileSize: 64,
        }]);
        mocks.openInputPaths.mockResolvedValue({
            kind: 'pdf',
            originalPath: recentPath,
            workingPath: '/tmp/restart-recent-working.pdf',
        });
        const { handleOpenPdfDirect } = await import('@electron/features/documents/main/documentOpenHandlers');
        const context = createOpenContext(42);

        await expect(handleOpenPdfDirect(context, recentPath)).resolves.toEqual({
            kind: 'pdf',
            originalPath: recentPath,
            workingPath: '/tmp/restart-recent-working.pdf',
        });

        expect(mocks.openInputPaths).toHaveBeenCalledWith([recentPath], {}, context.sender);
        expect(mocks.logRejectedOpenPath).not.toHaveBeenCalled();
    });

    it('opens paths granted to the requesting renderer without consulting recents', async () => {
        const grantedPath = '/tmp/direct-granted.pdf';
        const context = createOpenContext(42);
        mocks.allowedPathsByOwner.set(42, new Set([grantedPath]));
        mocks.openInputPaths.mockResolvedValue({
            kind: 'pdf',
            originalPath: grantedPath,
            workingPath: '/tmp/direct-granted-working.pdf',
        });
        const { handleOpenPdfDirect } = await import('@electron/features/documents/main/documentOpenHandlers');

        await expect(handleOpenPdfDirect(context, grantedPath)).resolves.toEqual({
            kind: 'pdf',
            originalPath: grantedPath,
            workingPath: '/tmp/direct-granted-working.pdf',
        });

        expect(mocks.getRecentFiles).not.toHaveBeenCalled();
        expect(mocks.openInputPaths).toHaveBeenCalledWith([grantedPath], {}, context.sender);
        expect(mocks.logRejectedOpenPath).not.toHaveBeenCalled();
    });

    it('discovers authoritative opening geometry only from the admitted working copy', async () => {
        const directPath = '/tmp/cold-large.pdf';
        const context = createOpenContext(42);
        const geometry = {
            pageNumber: 1 as const,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0 as const,
            size: 538_000_000,
            modifiedAt: 1_720_000_000_000,
        };
        mocks.allowedPathsByOwner.set(42, new Set([directPath]));
        mocks.handlePdfOpeningGeometry.mockResolvedValueOnce(geometry);
        mocks.openInputPaths.mockResolvedValueOnce({
            kind: 'pdf',
            originalPath: directPath,
            workingPath: '/tmp/cold-large-working.pdf',
        });
        const { handleOpenPdfDirect } = await import('@electron/features/documents/main/documentOpenHandlers');

        await expect(handleOpenPdfDirect(context, directPath)).resolves.toEqual({
            kind: 'pdf',
            originalPath: directPath,
            workingPath: '/tmp/cold-large-working.pdf',
            openingGeometry: geometry,
        });
        expect(mocks.handlePdfOpeningGeometry).toHaveBeenCalledWith(context, '/tmp/cold-large-working.pdf');
        expect(mocks.handlePdfOpeningGeometry).not.toHaveBeenCalledWith(context, directPath);
        expect(mocks.openInputPaths).toHaveBeenCalledWith([directPath], {}, context.sender);
        expect(mocks.openInputPaths.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.handlePdfOpeningGeometry.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
        );
    });

    it('rejects paths granted only to a different owner', async () => {
        const wronglyGrantedPath = '/tmp/wrong-owner.pdf';
        mocks.allowedPathsByOwner.set(0, new Set([wronglyGrantedPath]));
        const { handleOpenPdfDirect } = await import('@electron/features/documents/main/documentOpenHandlers');

        await expect(handleOpenPdfDirect(createOpenContext(42), wronglyGrantedPath)).rejects.toThrow('errors.file.invalid');

        expect(mocks.openInputPaths).not.toHaveBeenCalled();
        expect(mocks.logRejectedOpenPath).toHaveBeenCalledWith(wronglyGrantedPath);
    });

    it('still rejects a direct-open path that is neither capability-granted nor recent', async () => {
        const unknownPath = '/tmp/not-recent.pdf';
        const { handleOpenPdfDirect } = await import('@electron/features/documents/main/documentOpenHandlers');

        await expect(handleOpenPdfDirect(createOpenContext(24), unknownPath)).rejects.toThrow('errors.file.invalid');

        expect(mocks.openInputPaths).not.toHaveBeenCalled();
        expect(mocks.logRejectedOpenPath).toHaveBeenCalledWith(unknownPath);
    });
});
