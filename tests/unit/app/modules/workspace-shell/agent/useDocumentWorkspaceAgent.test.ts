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
import type { IWorkspacePdfViewerAgentPort } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import {
    DOCUMENT_WORKSPACE_AGENT_ACTION_IDS,
    DOCUMENT_WORKSPACE_AGENT_ALIAS_ACTION_IDS,
    DOCUMENT_WORKSPACE_AGENT_PRIMARY_ACTION_IDS,
    useDocumentWorkspaceAgent,
} from '@app/modules/workspace-shell/agent/useDocumentWorkspaceAgent';
import type { IUseDocumentWorkspaceAgentOptions } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';
import { cast } from '@tests/helpers/cast';

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

function createBookmark(title: string, items: IPdfBookmarkEntry[] = []): IPdfBookmarkEntry {
    return {
        title,
        pageIndex: null,
        namedDest: null,
        bold: false,
        italic: false,
        color: null,
        items,
    };
}

function createAnnotationComment(
    overrides: Partial<IAnnotationCommentSummary> = {},
): IAnnotationCommentSummary {
    return {
        id: 'annotation-1',
        stableKey: 'annotation-stable-1',
        pageIndex: 0,
        pageNumber: 1,
        text: '',
        kindLabel: 'Highlight',
        subtype: 'Highlight',
        author: null,
        modifiedAt: null,
        color: '#ffff00',
        uid: null,
        annotationId: 'annotation-1',
        source: 'pdf',
        hasNote: false,
        ...overrides,
    };
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
        canUndo: ref(false),
        canRedo: ref(false),
        closeAllDropdowns: vi.fn(),
        closeShapeProperties: vi.fn(),
        closeTextMarkupProperties: vi.fn(),
        continuousScroll: ref(false),
        currentPage: ref(1),
        fitMode: ref<unknown>('width'),
        handleActualSize: vi.fn(),
        handleAnnotationFocusComment: vi.fn(async () => undefined),
        handleAnnotationToolChange: vi.fn(),
        handleBookmarksChange: vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        }),
        updateTextMarkupColorWithHistory: vi.fn(() => true),
        handleDeleteAnnotationComment: vi.fn(async () => undefined),
        handleDropdownOpen: vi.fn(),
        handleExportDocx: vi.fn(async () => undefined),
        handleExportImages: vi.fn(async () => undefined),
        handleExportMultiPageTiff: vi.fn(async () => undefined),
        handleFitMode: vi.fn(),
        handleGoToPage: vi.fn(),
        handleOpenAnnotationNote: vi.fn(),
        handleOpenFileFromUi: vi.fn(async () => undefined),
        handleRepairSave: vi.fn(async () => true),
        handleOptimizePdfForInteraction: vi.fn(async () => true),
        handleUndo: vi.fn(async () => undefined),
        handleRedo: vi.fn(async () => undefined),
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
        handleCropPages: vi.fn(async () => true),
        handleRemoveCrop: vi.fn(async () => true),
        pdfViewerRef: ref<IWorkspacePdfViewerAgentPort | null>(null),
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
        waitForDocumentOpenSettled: vi.fn(async () => undefined),
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
        await expect(agent.runAgentAction('bookmarks.delete_batch', {}, {dryRun: true}))
            .rejects.toThrow('bookmarks.delete_batch requires input.paths, input.items with path, or input.path');

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

    it('waits for document open to settle before validating bookmark plan page numbers', async () => {
        const totalPages = ref(0);
        const waitForDocumentOpenSettled = vi.fn(async () => {
            totalPages.value = 3;
        });
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
            totalPages,
            waitForDocumentOpenSettled,
        }));

        await expect(agent.runAgentAction('bookmarks.apply_plan', {entries: [{
            level: 1,
            title: 'Chapter',
            page: 3,
        }]})).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.apply_plan',
            bookmarks: [expect.objectContaining({title: 'Chapter'})],
        });
        expect(waitForDocumentOpenSettled).toHaveBeenCalledOnce();
        expect(handleBookmarksChange).toHaveBeenCalledOnce();
        expect(handleBookmarksChange).toHaveBeenCalledWith(expect.objectContaining({
            dirty: true,
            history: 'record',
        }));
    });

    it('deletes multiple bookmarks through the batch agent action', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([
            createBookmark('Chapter 1', [createBookmark('Section 1.1')]),
            createBookmark('Chapter 2'),
            createBookmark('Chapter 3'),
        ]);
        const handleBookmarksChange = vi.fn(({bookmarks}) => {
            bookmarkItems.value = bookmarks;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            handleBookmarksChange,
        }));

        await expect(agent.runAgentAction('bookmarks.delete_batch', {paths: [
            [0],
            [
                0,
                0,
            ],
            [2],
        ]})).resolves.toMatchObject({
            ok: true,
            actionId: 'bookmarks.delete_batch',
            bookmarks: [expect.objectContaining({title: 'Chapter 2'})],
        });

        expect(bookmarkItems.value).toEqual([createBookmark('Chapter 2')]);
        expect(handleBookmarksChange).toHaveBeenCalledOnce();
        expect(handleBookmarksChange).toHaveBeenCalledWith(expect.objectContaining({
            dirty: true,
            history: 'record',
        }));
    });

    it('lets file.save observe save readiness after an immediate bookmark action', async () => {
        const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
        const bookmarksDirty = ref(false);
        const canSave = ref(false);
        const handleBookmarksChange = vi.fn(({
            bookmarks,
            dirty,
        }) => {
            bookmarkItems.value = bookmarks;
            bookmarksDirty.value = dirty;
            canSave.value = dirty;
        });
        const handleSave = vi.fn(async () => {
            expect(canSave.value).toBe(true);
            canSave.value = false;
            return true;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            bookmarkItems,
            bookmarksDirty,
            canSave,
            handleBookmarksChange,
            handleSave,
        }));

        await agent.runAgentAction('bookmarks.apply_plan', {entries: [{
            level: 1,
            title: 'Chapter',
            page: 1,
        }]});

        await expect(agent.runAgentAction('file.save')).resolves.toMatchObject({
            ok: true,
            actionId: 'file.save',
            saved: true,
            canSave: false,
        });
        expect(handleSave).toHaveBeenCalledOnce();
    });

    it('runs repair-save and optimize-for-interaction through semantic file actions', async () => {
        const handleRepairSave = vi.fn(async () => true);
        const handleOptimizePdfForInteraction = vi.fn(async () => true);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            handleRepairSave,
            handleOptimizePdfForInteraction,
            workingCopyPath: ref('/tmp/working.pdf'),
            originalPath: ref('/tmp/original.pdf'),
        }));

        await expect(agent.runAgentAction('file.repair_save')).resolves.toMatchObject({
            ok: true,
            actionId: 'file.repair_save',
            repaired: true,
            workingCopyPath: '/tmp/working.pdf',
            originalPath: '/tmp/original.pdf',
        });
        await expect(agent.runAgentAction('file.optimize_for_interaction')).resolves.toMatchObject({
            ok: true,
            actionId: 'file.optimize_for_interaction',
            optimized: true,
        });
        expect(handleRepairSave).toHaveBeenCalledOnce();
        expect(handleOptimizePdfForInteraction).toHaveBeenCalledOnce();
    });

    it('runs structured crop and remove-crop page operations', async () => {
        const handleCropPages = vi.fn(async () => true);
        const handleRemoveCrop = vi.fn(async () => true);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            handleCropPages,
            handleRemoveCrop,
            totalPages: ref(4),
        }));

        await expect(agent.runAgentAction('page_ops.crop', {
            pages: [
                2,
                2,
                4,
            ],
            margins: {
                top: 12,
                right: 6,
                bottom: 8,
                left: 6,
            },
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'page_ops.crop',
            pages: [
                2,
                4,
            ],
            margins: {
                top: 12,
                right: 6,
                bottom: 8,
                left: 6,
            },
            cropped: true,
        });
        await expect(agent.runAgentAction('page_ops.remove_crop', {pages: [4]})).resolves.toMatchObject({
            ok: true,
            actionId: 'page_ops.remove_crop',
            pages: [4],
            cropRemoved: true,
        });
        expect(handleCropPages).toHaveBeenCalledWith([
            2,
            4,
        ], {
            top: 12,
            right: 6,
            bottom: 8,
            left: 6,
        });
        expect(handleRemoveCrop).toHaveBeenCalledWith([4]);
    });

    it('guards history actions by undo and redo availability', async () => {
        const canUndo = ref(false);
        const canRedo = ref(true);
        const handleUndo = vi.fn(async () => undefined);
        const handleRedo = vi.fn(async () => {
            canUndo.value = true;
            canRedo.value = false;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            canUndo,
            canRedo,
            handleUndo,
            handleRedo,
        }));

        await expect(agent.runAgentAction('history.undo')).rejects.toThrow('Undo is not currently available.');
        await expect(agent.runAgentAction('history.redo')).resolves.toMatchObject({
            ok: true,
            actionId: 'history.redo',
            canUndo: true,
            canRedo: false,
        });
        expect(handleUndo).not.toHaveBeenCalled();
        expect(handleRedo).toHaveBeenCalledOnce();
    });

    it('routes assistant text-markup color edits through the undo-aware color updater', async () => {
        const comment = createAnnotationComment();
        const updateTextMarkupColorWithHistory = vi.fn(() => true);
        const rawViewerColorUpdate = vi.fn(() => true);
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            annotationComments: ref([comment]),
            updateTextMarkupColorWithHistory,
            pdfViewerRef: ref(cast<IWorkspacePdfViewerAgentPort>({updateTextMarkupAnnotationColor: rawViewerColorUpdate})),
        }));

        await expect(agent.runAgentAction('annotation.update_text_markup_color', {
            stableKey: comment.stableKey,
            color: '#00ff00',
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'annotation.update_text_markup_color',
            updated: true,
            comment: expect.objectContaining({
                stableKey: comment.stableKey,
                color: '#00ff00',
                hasNote: false,
            }),
        });

        expect(updateTextMarkupColorWithHistory).toHaveBeenCalledWith(comment, '#00ff00');
        expect(rawViewerColorUpdate).not.toHaveBeenCalled();
    });

    it('registers annotation history for assistant note text edits', async () => {
        const comment = createAnnotationComment({
            text: 'Original note',
            hasNote: true,
            kindLabel: 'Note',
            subtype: 'Text',
        });
        const historyCommands: Array<{
            cmd: () => void;
            undo: () => void;
        }> = [];
        const updateAnnotationComment = vi.fn(() => true);
        const registerAnnotationHistoryCommand = vi.fn((command: {
            cmd: () => void;
            undo: () => void;
        }) => {
            historyCommands.push(command);
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            annotationComments: ref([comment]),
            pdfViewerRef: ref(cast<IWorkspacePdfViewerAgentPort>({
                updateAnnotationComment,
                registerAnnotationHistoryCommand,
            })),
        }));

        await expect(agent.runAgentAction('annotation.update_note', {
            stableKey: comment.stableKey,
            text: 'Updated note',
        })).resolves.toMatchObject({
            ok: true,
            actionId: 'annotation.update_note',
            updated: true,
            comment: expect.objectContaining({
                stableKey: comment.stableKey,
                text: 'Updated note',
                hasNote: true,
            }),
        });

        expect(updateAnnotationComment).toHaveBeenCalledWith(comment, 'Updated note');
        expect(registerAnnotationHistoryCommand).toHaveBeenCalledOnce();

        const command = historyCommands[0];
        if (!command) {
            throw new Error('Expected annotation history command to be registered');
        }

        command.undo();
        expect(updateAnnotationComment).toHaveBeenLastCalledWith(comment, 'Original note');

        command.cmd();
        expect(updateAnnotationComment).toHaveBeenLastCalledWith(expect.objectContaining({
            stableKey: comment.stableKey,
            text: 'Updated note',
        }), 'Updated note');
    });

    it('blocks PDF page-operation actions in DjVu mode while keeping convert-to-PDF available', async () => {
        const selectedThumbnailPages = ref([
            1,
            2,
        ]);
        const showConvertDialog = ref(false);
        const pageOpsDelete = vi.fn(async () => undefined);
        const pageOpsExtract = vi.fn(async () => undefined);
        const pageOpsInsert = vi.fn(async () => undefined);
        const handlePageRotate = vi.fn(async () => undefined);
        const openConvertDialog = vi.fn(() => {
            showConvertDialog.value = true;
        });
        const agent = useDocumentWorkspaceAgent(createAgentOptions({
            handlePageRotate,
            isDjvuMode: ref(true),
            openConvertDialog,
            pageOpsDelete,
            pageOpsExtract,
            pageOpsInsert,
            selectedThumbnailPages,
            showConvertDialog,
        }));

        const blockedActions: Array<[string, Record<string, unknown>]> = [
            [
                'page_ops.delete_selected',
                {},
            ],
            [
                'page_ops.extract_selected',
                {},
            ],
            [
                'page_ops.rotate_cw_selected',
                {},
            ],
            [
                'page_ops.rotate_ccw_selected',
                {},
            ],
            [
                'page_ops.insert_pages',
                { afterPage: 2 },
            ],
            [
                'page_ops.crop',
                {
                    pages: [1],
                    margins: {
                        top: 1,
                        right: 1,
                        bottom: 1,
                        left: 1,
                    },
                },
            ],
            [
                'page_ops.remove_crop',
                { pages: [1] },
            ],
        ];

        for (const [
            actionId,
            input,
        ] of blockedActions) {
            await expect(agent.runAgentAction(actionId, input)).resolves.toMatchObject({
                ok: false,
                actionId,
                blocked: true,
                reason: 'djvu-page-operations-disabled',
                requiredAction: 'page_ops.convert_to_pdf',
            });
        }

        expect(pageOpsDelete).not.toHaveBeenCalled();
        expect(pageOpsExtract).not.toHaveBeenCalled();
        expect(pageOpsInsert).not.toHaveBeenCalled();
        expect(handlePageRotate).not.toHaveBeenCalled();

        await expect(agent.runAgentAction('page_ops.convert_to_pdf', {})).resolves.toMatchObject({
            ok: true,
            actionId: 'page_ops.convert_to_pdf',
            showConvertDialog: true,
        });
        expect(openConvertDialog).toHaveBeenCalledOnce();
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
