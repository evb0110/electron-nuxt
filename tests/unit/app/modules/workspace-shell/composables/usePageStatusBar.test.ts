import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePageStatusBar } from '@app/modules/workspace-shell/composables/usePageStatusBar';

const {
    getWorkingCopyBackingStatusMock,
    onWorkingCopyBackingStatusChangedMock,
    showItemInFolderMock,
    statFileMock,
} = vi.hoisted(() => ({
    getWorkingCopyBackingStatusMock: vi.fn(async (): Promise<{
        documentRef: string;
        failure: null;
        progress: number;
        state: 'lazy-original' | 'materializing' | 'materialized';
    } | null> => null),
    onWorkingCopyBackingStatusChangedMock: vi.fn(),
    showItemInFolderMock: vi.fn(async () => true),
    statFileMock: vi.fn(async () => ({ size: 0 })),
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentWindowCapability: () => ({ showItemInFolder: showItemInFolderMock }),
    getDocumentFilesCapability: () => ({
        getWorkingCopyBackingStatus: getWorkingCopyBackingStatusMock,
        onWorkingCopyBackingStatusChanged: onWorkingCopyBackingStatusChangedMock,
        statFile: statFileMock,
    }),
}));

function createDeps(overrides: Partial<Parameters<typeof usePageStatusBar>[0]> = {}) {
    return {
        hasDocument: ref(true),
        pdfSrc: ref(null),
        pdfData: ref(null),
        originalPath: ref<string | null>(null),
        workingCopyPath: ref<string | null>(null),
        effectiveZoom: ref(1),
        canSave: ref(false),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        handleSave: vi.fn(async () => {}),
        ...overrides,
    };
}

describe('usePageStatusBar', () => {
    beforeEach(() => {
        showItemInFolderMock.mockClear();
        getWorkingCopyBackingStatusMock.mockClear();
        getWorkingCopyBackingStatusMock.mockResolvedValue(null);
        onWorkingCopyBackingStatusChangedMock.mockReset();
        statFileMock.mockClear();
        statFileMock.mockResolvedValue({ size: 0 });
    });

    it('shows the folder action only for filesystem-backed document refs', async () => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string, params?: {
            size?: string;
            zoom?: number 
        }) => {
            if (key === 'status.fileSizeValue') {
                return `size:${params?.size ?? ''}`;
            }
            if (key === 'status.zoomValue') {
                return `zoom:${params?.zoom ?? ''}`;
            }
            return key;
        } }));

        const browserStatusBar = usePageStatusBar(createDeps({ originalPath: ref('browser://documents/example.pdf') }));
        const fileStatusBar = usePageStatusBar(createDeps({ originalPath: ref('/tmp/example.pdf') }));

        expect(browserStatusBar.statusCanShowInFolder.value).toBe(false);
        expect(fileStatusBar.statusCanShowInFolder.value).toBe(true);
    });

    it('does not invoke show-in-folder for browser-backed refs', async () => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        const statusBar = usePageStatusBar(createDeps({ originalPath: ref('browser://documents/example.pdf') }));

        await statusBar.handleStatusShowInFolderClick();

        expect(showItemInFolderMock).not.toHaveBeenCalled();
    });

    it('reveals filesystem-backed refs through the window capability', async () => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        const statusBar = usePageStatusBar(createDeps({ originalPath: ref('/tmp/example.pdf') }));

        await statusBar.handleStatusShowInFolderClick();

        expect(showItemInFolderMock).toHaveBeenCalledWith('/tmp/example.pdf');
    });

    it('explains browser-backed documents instead of saying no file is open', () => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        const statusBar = usePageStatusBar(createDeps({ originalPath: ref('browser://documents/source/%D0%A2%D1%80%D1%83%D0%B4.pdf') }));

        expect(statusBar.statusFilePath.value).toBe('Труд.pdf');
        expect(statusBar.statusShowInFolderTooltip.value).toBe('status.showInFolderUnavailableWeb');
        expect(statusBar.statusShowInFolderAriaLabel.value).toBe('status.showInFolderUnavailableWeb');
    });

    it('shows the file name for display while keeping the full path available', () => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        const statusBar = usePageStatusBar(createDeps({ originalPath: ref('/Users/evb/Desktop/To/book.djvu') }));

        expect(statusBar.statusFileName.value).toBe('book.djvu');
        expect(statusBar.statusFilePath.value).toBe('/Users/evb/Desktop/To/book.djvu');
    });

    it('falls back to the on-disk size when the document has no in-memory bytes', async () => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string, params?: { size?: string }) => (
            key === 'status.fileSizeValue' ? `size:${params?.size ?? ''}` : key
        ) }));
        statFileMock.mockResolvedValue({ size: 2048 });

        const statusBar = usePageStatusBar(createDeps({
            originalPath: ref('/Users/evb/Desktop/book.djvu'),
            workingCopyPath: ref('/tmp/managed/book.djvu'),
        }));

        await vi.waitFor(() => {
            expect(statusBar.statusFileSizeLabel.value).toContain('2.00 KB');
        });
        expect(statFileMock).toHaveBeenCalledWith('/tmp/managed/book.djvu');
        expect(statFileMock).not.toHaveBeenCalledWith('/Users/evb/Desktop/book.djvu');
    });

    it('uses trusted opening metadata for a DjVu without a managed working copy', () => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string, params?: { size?: string }) => (
            key === 'status.fileSizeValue' ? `size:${params?.size ?? ''}` : key
        ) }));
        const statusBar = usePageStatusBar(createDeps({
            knownFileSizeBytes: ref(4096),
            originalPath: ref('/Users/evb/Desktop/book.djvu'),
        }));

        expect(statusBar.statusFileSizeLabel.value).toContain('4.00 KB');
        expect(statFileMock).not.toHaveBeenCalled();
    });

    it('does not stat an unadopted filesystem path while its visual open is pending', async () => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        const isDocumentVisualPending = ref(true);
        usePageStatusBar(createDeps({
            isDocumentVisualPending,
            originalPath: ref('/tmp/pending-book.djvu'),
        }));

        await Promise.resolve();
        expect(statFileMock).not.toHaveBeenCalled();

        isDocumentVisualPending.value = false;
        await Promise.resolve();
        expect(statFileMock).not.toHaveBeenCalled();

        const workingCopyPath = ref<string | null>(null);
        usePageStatusBar(createDeps({
            isDocumentVisualPending: ref(false),
            originalPath: ref('/tmp/adopted-book.djvu'),
            workingCopyPath,
        }));
        workingCopyPath.value = '/tmp/managed/adopted-book.djvu';
        await vi.waitFor(() => {
            expect(statFileMock).toHaveBeenCalledWith('/tmp/managed/adopted-book.djvu');
        });
        expect(statFileMock).not.toHaveBeenCalledWith('/tmp/pending-book.djvu');
        expect(statFileMock).not.toHaveBeenCalledWith('/tmp/adopted-book.djvu');
    });

    it('derives a quiet monotonic materialization label from the native status stream', async () => {
        let listener: ((status: {
            documentRef: string;
            failure: null;
            progress: number;
            state: 'lazy-original' | 'materializing' | 'materialized';
        }) => void) | undefined;
        onWorkingCopyBackingStatusChangedMock.mockImplementation((callback) => {
            listener = callback;
            return vi.fn();
        });
        getWorkingCopyBackingStatusMock.mockResolvedValue({
            documentRef: '/tmp/managed.pdf',
            failure: null,
            progress: 0,
            state: 'lazy-original',
        });
        vi.stubGlobal('useTypedI18n', () => ({ t: (
            key: string,
            params?: {progress?: number},
        ) => params?.progress === undefined ? key : `${key}:${params.progress}` }));
        const statusBar = usePageStatusBar(createDeps({workingCopyPath: ref('/tmp/managed.pdf')}));

        await vi.waitFor(() => {
            expect(statusBar.statusMaterializationLabel.value).toBe('status.preparingDocument');
        });
        listener?.({
            documentRef: '/tmp/managed.pdf',
            failure: null,
            progress: 0.42,
            state: 'materializing',
        });
        listener?.({
            documentRef: '/tmp/managed.pdf',
            failure: null,
            progress: 0.2,
            state: 'materializing',
        });

        expect(statusBar.statusMaterializationLabel.value).toContain('42');
        expect(statusBar.statusMaterializationIsActive.value).toBe(true);

        listener?.({
            documentRef: '/tmp/managed.pdf',
            failure: null,
            progress: 1,
            state: 'materialized',
        });
        expect(statusBar.statusMaterializationLabel.value).toBeNull();
        expect(statusBar.statusMaterializationIsActive.value).toBe(false);
    });
});
