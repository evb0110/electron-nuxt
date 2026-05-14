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
vi.mock('@electron/i18n', () => ({ te: (key: string) => key }));
vi.mock('@electron/utils/error', () => ({ getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error) }));
vi.mock('@electron/utils/logger', () => ({ createLogger: () => mocks.logger }));
vi.mock('@electron/image/pdfConversion', () => ({
    isSupportedOpenPath: () => true,
    SUPPORTED_IMAGE_EXTENSIONS: ['.png'],
}));
vi.mock('@electron/recentFiles', () => ({ getRecentFiles: mocks.getRecentFiles }));
vi.mock('@electron/features/documents/main/documentOpen.service', () => ({ openInputPaths: mocks.openInputPaths }));
vi.mock('@electron/features/documents/main/documentDialogCommon', () => ({
    errorWithDetails: (fallbackMessage: string, details: unknown) => (
        details instanceof Error
            ? new Error(`${fallbackMessage}: ${details.message}`)
            : new Error(fallbackMessage)
    ),
    getOpenDialogParentWindow: () => null,
    showOpenDocumentDialog: mocks.showOpenDocumentDialog,
}));
vi.mock('@electron/ipc/openPathCapabilities', () => ({
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

function createEvent(ownerId: number) {
    return { sender: { id: ownerId } } as Electron.IpcMainInvokeEvent;
}

describe('document direct-open recent authorization', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.allowedPathsByOwner.clear();
        mocks.getRecentFiles.mockResolvedValue([]);
        mocks.openInputPaths.mockResolvedValue(null);
    });

    it('allows a trusted recent file to open after an Electron restart clears renderer capabilities', async () => {
        const recentPath = '/tmp/restart-recent.pdf';
        const event = createEvent(42);
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

        await expect(handleOpenPdfDirect(event, recentPath)).resolves.toEqual({
            kind: 'pdf',
            originalPath: recentPath,
            workingPath: '/tmp/restart-recent-working.pdf',
        });

        expect(mocks.openInputPaths).toHaveBeenCalledWith([recentPath], {}, event.sender);
        expect(mocks.logRejectedOpenPath).not.toHaveBeenCalled();
    });

    it('still rejects a direct-open path that is neither capability-granted nor recent', async () => {
        const unknownPath = '/tmp/not-recent.pdf';
        const { handleOpenPdfDirect } = await import('@electron/features/documents/main/documentOpenHandlers');

        await expect(handleOpenPdfDirect(createEvent(24), unknownPath)).rejects.toThrow('errors.file.invalid');

        expect(mocks.openInputPaths).not.toHaveBeenCalled();
        expect(mocks.logRejectedOpenPath).toHaveBeenCalledWith(unknownPath);
    });
});
