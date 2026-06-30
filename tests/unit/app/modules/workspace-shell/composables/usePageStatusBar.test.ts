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
    legacyShowItemInFolderMock,
    showItemInFolderMock,
    statFileMock,
} = vi.hoisted(() => ({
    legacyShowItemInFolderMock: vi.fn(() => {
        throw new Error('legacy documents window capability should not be used');
    }),
    showItemInFolderMock: vi.fn(async () => true),
    statFileMock: vi.fn(async () => ({ size: 0 })),
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentWindowCapability: () => ({ showItemInFolder: showItemInFolderMock }),
    getDocumentFilesCapability: () => ({ statFile: statFileMock }),
    getDocumentsCapability: () => ({ showItemInFolder: legacyShowItemInFolderMock }),
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
        legacyShowItemInFolderMock.mockClear();
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
        expect(legacyShowItemInFolderMock).not.toHaveBeenCalled();
    });

    it('reveals filesystem-backed refs through the window capability', async () => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        const statusBar = usePageStatusBar(createDeps({ originalPath: ref('/tmp/example.pdf') }));

        await statusBar.handleStatusShowInFolderClick();

        expect(showItemInFolderMock).toHaveBeenCalledWith('/tmp/example.pdf');
        expect(legacyShowItemInFolderMock).not.toHaveBeenCalled();
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

        const statusBar = usePageStatusBar(createDeps({ originalPath: ref('/tmp/book.djvu') }));

        await vi.waitFor(() => {
            expect(statusBar.statusFileSizeLabel.value).toContain('2.00 KB');
        });
        expect(statFileMock).toHaveBeenCalledWith('/tmp/book.djvu');
    });
});
