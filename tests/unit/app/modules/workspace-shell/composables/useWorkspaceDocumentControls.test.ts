import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TDocumentRef } from '@contracts/platformApi';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';

const mocks = vi.hoisted(() => ({ pageOpsDeps: null as null | { onExtractedDocument?: (path: TDocumentRef) => Promise<void> | void; } }));

vi.mock('@app/modules/workspace-shell/composables/usePageStatusBar', () => ({ usePageStatusBar: () => ({}) }));

vi.mock('@app/modules/workspace-shell/composables/usePageOpsHandlers', () => ({ usePageOpsHandlers: (deps: unknown) => {
    mocks.pageOpsDeps = deps as { onExtractedDocument?: (path: TDocumentRef) => Promise<void> | void; };
    return {};
} }));

vi.mock('@app/modules/workspace-shell/composables/usePageFileOperations', () => ({ usePageFileOperations: () => ({}) }));

const { useWorkspaceDocumentControls } = await import('@app/modules/workspace-shell/composables/useWorkspaceDocumentControls');

const openedOutcome: TDocumentOpenOutcome = {
    status: 'opened',
    result: {
        kind: 'pdf',
        originalPath: '/tmp/source.pdf',
        workingPath: '/tmp/working.pdf',
    },
};

function createOptions() {
    return {
        hasDocument: ref(false),
        pdfSrc: ref(null),
        pdfData: ref(null),
        originalPath: ref<TDocumentRef | null>(null),
        workingCopyPath: ref<TDocumentRef | null>(null),
        currentPage: ref(1),
        effectiveZoom: ref(1),
        canSave: ref(false),
        isAnySaving: ref(false),
        isHistoryBusy: ref(false),
        handleSave: vi.fn(async () => {}),
        totalPages: ref(1),
        selectedThumbnailPages: ref<number[]>([]),
        setSelectedThumbnailPages: vi.fn(),
        requestThumbnailInvalidation: vi.fn(),
        pdfViewerRef: ref(null),
        pageContextMenu: ref({
            visible: false,
            pages: [],
        }),
        closePageContextMenu: vi.fn(),
        handleExportImages: vi.fn(async () => {}),
        ensureHistoryBaselineForExternalMutation: vi.fn(async () => true),
        reloadWorkingCopyIntoHistory: vi.fn(async () => true),
        preparePdfReloadWaiter: vi.fn(() => ({
            promise: Promise.resolve(),
            cancel: vi.fn(),
        })),
        clearOcrCache: vi.fn(),
        resetSearchCache: vi.fn(),
        isExportingDocx: ref(false),
        isAnyAnnotationNoteSaving: ref(false),
        annotationNoteWindows: ref([]),
        annotationDirty: ref(false),
        isDirty: ref(false),
        pageLabelsDirty: ref(false),
        bookmarksDirty: ref(false),
        hasAnnotationChanges: vi.fn(() => false),
        persistAllAnnotationNotes: vi.fn(async () => true),
        pickFileToOpenWithDjvuCleanup: vi.fn(async () => null),
        openFileWithDjvuCleanup: vi.fn(async () => openedOutcome),
        openFileDirectWithDjvuCleanup: vi.fn(async () => openedOutcome),
        openFileDirectBatchWithDjvuCleanup: vi.fn(async () => openedOutcome),
        closeFileWithDjvuCleanup: vi.fn(async () => {}),
        closeAllDropdowns: vi.fn(),
        emitOpenInNewTab: vi.fn(),
        removeRecentFile: vi.fn(async () => {}),
        notifyMissingRecentFile: vi.fn(),
    };
}

describe('useWorkspaceDocumentControls', () => {
    beforeEach(() => {
        mocks.pageOpsDeps = null;
        vi.clearAllMocks();
    });

    it('reopens extracted PDFs by original path so the new tab creates its own working copy', async () => {
        const options = createOptions();

        useWorkspaceDocumentControls(options);

        expect(mocks.pageOpsDeps?.onExtractedDocument).toBeTypeOf('function');

        await mocks.pageOpsDeps?.onExtractedDocument?.('C:\\Users\\andrej\\Downloads\\extract.pdf');

        expect(options.emitOpenInNewTab).toHaveBeenCalledWith('C:\\Users\\andrej\\Downloads\\extract.pdf');
    });
});
