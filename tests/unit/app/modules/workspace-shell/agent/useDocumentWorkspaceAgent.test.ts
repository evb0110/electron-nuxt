import { ref } from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TPdfViewMode } from '@contracts/shared';
import { AGENT_CAPABILITY_TEMPLATES } from '@electron/features/agent/mcp/agentCapabilityTemplates';
import type {
    IAnnotationCommentSummary,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfBookmarkEntry } from '@app/types/pdf';
import type { IAnnotationNoteWindowState } from '@app/types/annotationNoteWindow';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import {
    DOCUMENT_WORKSPACE_AGENT_ACTION_IDS,
    DOCUMENT_WORKSPACE_AGENT_ALIAS_ACTION_IDS,
    DOCUMENT_WORKSPACE_AGENT_PRIMARY_ACTION_IDS,
    useDocumentWorkspaceAgent,
} from '@app/modules/workspace-shell/agent/useDocumentWorkspaceAgent';
import type { IUseDocumentWorkspaceAgentOptions } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';

const COMMAND_ONLY_CAPABILITY_IDS = new Set([
    'workspace.snapshot',
    'document.open_documents',
    'document.readiness',
    'document.inspect_text',
    'document.search',
    'document.read_pages',
    'annotation.list',
    'annotation.list_notes',
    'view.activate_tab',
    'view.go_to_page',
]);

function sortIds(ids: readonly string[]) {
    return [...ids].sort((left, right) => left.localeCompare(right));
}

function createAgentOptions(
    overrides: Partial<IUseDocumentWorkspaceAgentOptions> = {},
): IUseDocumentWorkspaceAgentOptions {
    const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
    const pageLabelRanges = ref([{
        startPage: 1,
        style: 'D' as const,
        prefix: '',
        startNumber: 1,
    }]);
    const showSidebar = ref(false);
    const sidebarTab = ref<'annotations' | 'bookmarks' | 'thumbnails' | 'search'>('annotations');

    return {
        annotationComments: ref<IAnnotationCommentSummary[]>([]),
        annotationCommentsStatus: ref<TAnnotationCommentsStatus>('ready'),
        annotationDirty: ref(false),
        annotationPlacingPageNote: ref(false),
        annotationTool: ref<TAnnotationTool>('none'),
        bookmarkItems,
        bookmarksDirty: ref(false),
        canSave: ref(false),
        closeAllDropdowns: vi.fn(),
        closeShapeProperties: vi.fn(),
        closeTextMarkupProperties: vi.fn(),
        continuousScroll: ref(false),
        currentPage: ref(1),
        dragMode: ref(false),
        enableDragMode: vi.fn(),
        fitMode: ref<unknown>('width'),
        handleActualSize: vi.fn(),
        handleAnnotationFocusComment: vi.fn(async () => undefined),
        handleAnnotationToolChange: vi.fn(),
        handleBookmarksChange: vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        }),
        handleDeleteAnnotationComment: vi.fn(async () => undefined),
        handleDropdownOpen: vi.fn(),
        handleExportDocx: vi.fn(async () => undefined),
        handleExportImages: vi.fn(async () => undefined),
        handleExportMultiPageTiff: vi.fn(async () => undefined),
        handleFitMode: vi.fn(),
        handleGoToPage: vi.fn(),
        handleOpenAnnotationNote: vi.fn(),
        handleOpenFileFromUi: vi.fn(async () => undefined),
        handlePageLabelRangesUpdate: vi.fn((ranges) => {
            pageLabelRanges.value = ranges;
        }),
        handlePageRotate: vi.fn(async () => undefined),
        handlePrint: vi.fn(),
        handlePrintCurrentPage: vi.fn(async () => undefined),
        handleQuickNoteAction: vi.fn(async () => undefined),
        handleSave: vi.fn(async () => true),
        handleSaveAs: vi.fn(async () => undefined),
        handleZoomIn: vi.fn(),
        handleZoomOut: vi.fn(),
        hasPdf: ref(true),
        isAnySaving: ref(false),
        isDjvuMode: ref(false),
        isSameAnnotationComment: (left, right) => left.stableKey === right.stableKey,
        markAnnotationDirty: vi.fn(),
        ocrPopupOpen: ref(false),
        ocrPopupRef: ref(null),
        openConvertDialog: vi.fn(),
        originalPath: ref<TDocumentRef | null>(null),
        pageLabelRanges,
        pageLabels: ref<string[] | null>(null),
        pageLabelsDirty: ref(false),
        pageOpsDelete: vi.fn(async () => undefined),
        pageOpsExtract: vi.fn(async () => undefined),
        pageOpsInsert: vi.fn(async () => undefined),
        pdfViewerRef: ref<IPdfViewerExpose | null>(null),
        selectedThumbnailPages: ref([]),
        showConvertDialog: ref(false),
        showSidebar,
        sidebarTab,
        sortedAnnotationNoteWindows: ref<IAnnotationNoteWindowState[]>([]),
        t: () => 'Untitled',
        tabId: 'tab-1',
        totalPages: ref(3),
        updateAnnotationNoteText: vi.fn(),
        viewMode: ref<TPdfViewMode>('single'),
        workingCopyPath: ref<TDocumentRef | null>(null),
        zoom: ref(1),
        ...overrides,
    };
}

describe('useDocumentWorkspaceAgent', () => {
    it('keeps primary renderer action handlers aligned with advertised capabilities', () => {
        const advertisedRendererActionIds = AGENT_CAPABILITY_TEMPLATES
            .map(template => template.id)
            .filter(id => !COMMAND_ONLY_CAPABILITY_IDS.has(id));

        expect(sortIds(DOCUMENT_WORKSPACE_AGENT_PRIMARY_ACTION_IDS)).toEqual(
            sortIds(advertisedRendererActionIds),
        );
    });

    it('keeps compatibility aliases separate from public primary capability ids', () => {
        const primaryIds = new Set<string>(DOCUMENT_WORKSPACE_AGENT_PRIMARY_ACTION_IDS);

        expect(new Set(DOCUMENT_WORKSPACE_AGENT_ACTION_IDS).size).toBe(DOCUMENT_WORKSPACE_AGENT_ACTION_IDS.length);
        expect(DOCUMENT_WORKSPACE_AGENT_ALIAS_ACTION_IDS.every(id => !primaryIds.has(id))).toBe(true);
    });

    it('validates action id and required input before reporting a dry-run would run', async () => {
        const showSidebar = ref(false);
        const sidebarTab = ref<'annotations' | 'bookmarks' | 'thumbnails' | 'search'>('annotations');
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            showSidebar,
            sidebarTab,
        }));

        await expect(agent.runAgentAction('missing.action', {}, {dryRun: true}))
            .rejects.toThrow('Unsupported EVB agent action: missing.action');
        await expect(agent.runAgentAction('ui.open_sidebar_tab', {tab: 'layers'}, {dryRun: true}))
            .rejects.toThrow('ui.open_sidebar_tab requires input.tab');
        await expect(agent.runAgentAction('view.set_mode', {mode: 'scroll'}, {dryRun: true}))
            .rejects.toThrow('view.set_mode requires input.mode');
        await expect(agent.runAgentAction('annotation.create_note_at_point', {}, {dryRun: true}))
            .rejects.toThrow('annotation.create_note_at_point requires input.pageX and input.pageY');
        await expect(agent.runAgentAction('page_labels.apply_range', {}, {dryRun: true}))
            .rejects.toThrow('page_labels.apply_range requires a valid one-based page number');
        await expect(agent.runAgentAction('bookmarks.add_batch', {}, {dryRun: true}))
            .rejects.toThrow('bookmarks.add_batch requires input.bookmarks or input.items');

        await expect(agent.runAgentAction('ui.open_sidebar_tab', {tab: 'bookmarks'}, {dryRun: true}))
            .resolves.toMatchObject({
                ok: true,
                actionId: 'ui.open_sidebar_tab',
                dryRun: true,
                wouldRun: true,
            });
        expect(showSidebar.value).toBe(false);
        expect(sidebarTab.value).toBe('annotations');
    });

    it('preserves execution semantics for a representative handler', async () => {
        const showSidebar = ref(false);
        const sidebarTab = ref<'annotations' | 'bookmarks' | 'thumbnails' | 'search'>('annotations');
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            showSidebar,
            sidebarTab,
        }));

        await expect(agent.runAgentAction('ui.open_sidebar_tab', {sidebarTab: 'bookmarks'}))
            .resolves.toMatchObject({
                ok: true,
                actionId: 'ui.open_sidebar_tab',
                tabId: 'tab-1',
                currentPage: 1,
                totalPages: 3,
                showSidebar: true,
                sidebarTab: 'bookmarks',
            });
        expect(showSidebar.value).toBe(true);
        expect(sidebarTab.value).toBe('bookmarks');
    });

    it('passes OCR quality profile through the OCR start action', async () => {
        const runOcrForAgent = vi.fn(async () => ({ok: true}));
        const handleDropdownOpen = vi.fn();
        const ocrPopupRef = ref({
            runOcrForAgent,
            cancelOcrForAgent: vi.fn(async () => ({ok: true})),
            getAgentOcrSnapshot: vi.fn(() => ({})),
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            handleDropdownOpen,
            ocrPopupRef,
        }));

        await expect(agent.runAgentAction('ocr.start', {
            pageRange: 'all',
            languages: [
                'eng',
                'eng',
                'rus',
            ],
            qualityProfile: 'poor-scan',
            preprocessingMode: 'clean',
            pageSegmentationMode: 11,
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'ocr.start',
            tabId: 'tab-1',
        });

        expect(handleDropdownOpen).toHaveBeenCalledWith('ocr', true);
        expect(runOcrForAgent).toHaveBeenCalledWith({
            pageRange: 'all',
            languages: [
                'eng',
                'rus',
            ],
            qualityProfile: 'poor-scan',
            preprocessingMode: 'clean',
            pageSegmentationMode: 11,
            open: true,
        });
    });

    it('drops invalid OCR tuning inputs before invoking the popup', async () => {
        const runOcrForAgent = vi.fn(async () => ({ok: true}));
        const ocrPopupRef = ref({
            runOcrForAgent,
            cancelOcrForAgent: vi.fn(async () => ({ok: true})),
            getAgentOcrSnapshot: vi.fn(() => ({})),
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({ocrPopupRef}));

        await agent.runAgentAction('ocr.start', {
            qualityProfile: 'stock',
            preprocessingMode: 'maybe',
            pageSegmentationMode: 42,
        });

        expect(runOcrForAgent).toHaveBeenCalledWith({open: true});
    });

    it('awaits OCR cancel results from the popup', async () => {
        const cancelOcrForAgent = vi.fn(async () => ({
            ok: false,
            cancel: {
                canceled: false,
                reason: 'not-found',
            },
        }));
        const ocrPopupRef = ref({
            runOcrForAgent: vi.fn(async () => ({ok: true})),
            cancelOcrForAgent,
            getAgentOcrSnapshot: vi.fn(() => ({})),
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({ocrPopupRef}));

        await expect(agent.runAgentAction('ocr.cancel', {})).resolves.toMatchObject({
            ok: false,
            cancel: {
                canceled: false,
                reason: 'not-found',
            },
            actionId: 'ocr.cancel',
            tabId: 'tab-1',
        });
        expect(cancelOcrForAgent).toHaveBeenCalledTimes(1);
    });
});
