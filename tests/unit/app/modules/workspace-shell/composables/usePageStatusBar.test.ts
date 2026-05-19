import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePageStatusBar } from '@app/modules/workspace-shell/composables/usePageStatusBar';

const showItemInFolderMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@app/utils/platformDocuments', () => ({ getDocumentsCapability: () => ({ showItemInFolder: showItemInFolderMock }) }));

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

    it('explains browser-backed documents instead of saying no file is open', () => {
        vi.stubGlobal('useTypedI18n', () => ({ t: (key: string) => key }));
        const statusBar = usePageStatusBar(createDeps({ originalPath: ref('browser://documents/source/%D0%A2%D1%80%D1%83%D0%B4.pdf') }));

        expect(statusBar.statusFilePath.value).toBe('Труд.pdf');
        expect(statusBar.statusShowInFolderTooltip.value).toBe('status.showInFolderUnavailableWeb');
        expect(statusBar.statusShowInFolderAriaLabel.value).toBe('status.showInFolderUnavailableWeb');
    });
});
