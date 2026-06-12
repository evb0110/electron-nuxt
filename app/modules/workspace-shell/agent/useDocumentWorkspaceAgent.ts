import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/public';
import {
    getAgentNumberInput,
    getAgentNumberArrayInput,
    getAgentRawStringInput,
    getAgentStringArrayInput,
    getAgentStringInput,
    hasAgentInputKey,
    isAgentAnnotationTool,
    isAgentOcrPageRange,
    isAgentRecord,
    isAgentSidebarTab,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import type {
    IAgentOcrRunOptions,
    IUseDocumentWorkspaceAgentOptions,
    TWorkspaceAgentSidebarTab,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';
import { createDocumentAgentAnnotations } from '@app/modules/workspace-shell/agent/createDocumentAgentAnnotations';
import { createDocumentAgentBookmarks } from '@app/modules/workspace-shell/agent/createDocumentAgentBookmarks';
import { createDocumentAgentPageImageCapture } from '@app/modules/workspace-shell/agent/createDocumentAgentPageImageCapture';
import { createDocumentAgentPageLabels } from '@app/modules/workspace-shell/agent/createDocumentAgentPageLabels';
import { createDocumentAgentResources } from '@app/modules/workspace-shell/agent/createDocumentAgentResources';
import {
    getAgentPageNumberInput,
    normalizeAgentPageNumber,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPages';

export type { IOcrPopupAgentExpose } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';

export const DOCUMENT_WORKSPACE_AGENT_PRIMARY_ACTION_IDS = [
    'ui.open_sidebar_tab',
    'ui.toggle_sidebar',
    'ui.close_popups',
    'ocr.open_popup',
    'ocr.status',
    'ocr.start',
    'ocr.cancel',
    'document.capture_page_image',
    'page_labels.read',
    'page_labels.preview',
    'page_labels.apply_plan',
    'page_labels.set_ranges',
    'page_labels.apply_range',
    'page_labels.set_labels',
    'page_labels.clear',
    'bookmarks.read',
    'bookmarks.preview_tree',
    'bookmarks.apply_plan',
    'bookmarks.set_tree',
    'bookmarks.add',
    'bookmarks.add_batch',
    'bookmarks.update',
    'bookmarks.delete',
    'toc.read',
    'annotation.open_note',
    'annotation.focus',
    'annotation.update_note',
    'annotation.update_text_markup_color',
    'annotation.delete',
    'annotation.create_note',
    'annotation.create_note_at_point',
    'annotation.select_tool',
    'annotation.create_text_markup',
    'annotation.create_shape',
    'file.save',
    'file.save_as',
    'file.print',
    'file.print_current_page',
    'export.docx',
    'export.images',
    'export.multi_page_tiff',
    'view.zoom_in',
    'view.zoom_out',
    'view.fit_width',
    'view.fit_height',
    'view.actual_size',
    'view.toggle_continuous_scroll',
    'view.set_mode',
    'page_ops.delete_selected',
    'page_ops.extract_selected',
    'page_ops.rotate_cw_selected',
    'page_ops.rotate_ccw_selected',
    'page_ops.insert_pages',
    'page_ops.convert_to_pdf',
] as const;

export const DOCUMENT_WORKSPACE_AGENT_ALIAS_ACTION_IDS = [
    'document.screenshot_page',
    'page_numbering.read',
    'page_numbering.preview',
    'page_numbering.apply_plan',
    'page_numbering.set_ranges',
    'page_numbering.apply_range',
    'page_numbering.set_labels',
    'page_numbering.clear',
    'toc.preview_tree',
    'toc.apply_plan',
    'toc.set_tree',
    'toc.add',
    'toc.add_batch',
    'toc.update',
    'toc.delete',
    'annotation.start_note_placement',
    'annotation.place_note',
    'annotation.set_tool',
    'annotation.mark_text',
    'annotation.draw_shape',
    'view.enable_drag_mode',
    'view.disable_drag_mode',
] as const;

export const DOCUMENT_WORKSPACE_AGENT_ACTION_IDS = [
    ...DOCUMENT_WORKSPACE_AGENT_PRIMARY_ACTION_IDS,
    ...DOCUMENT_WORKSPACE_AGENT_ALIAS_ACTION_IDS,
] as const;

type TAgentActionHandlerRunResult = object | Promise<object>;

interface IAgentActionHandler {
    parse: (input: Record<string, unknown>, actionId: string) => unknown;
    run: (parsedInput: unknown, actionId: string) => TAgentActionHandlerRunResult;
}

interface IAgentActionHandlerDefinition<TParsedInput> {
    ids: readonly string[];
    parse(input: Record<string, unknown>, actionId: string): TParsedInput;
    run(parsedInput: TParsedInput, actionId: string): TAgentActionHandlerRunResult;
}

interface IAgentUpdateNoteInput {
    input: Record<string, unknown>;
    markerRect: IAnnotationCommentSummary['markerRect'] | null;
    text: string;
}

function createAgentActionHandler<TParsedInput>(
    definition: IAgentActionHandlerDefinition<TParsedInput>,
): IAgentActionHandler {
    return {
        parse: definition.parse,
        run: (parsedInput, actionId) => definition.run(parsedInput as TParsedInput, actionId),
    };
}

function createAgentActionHandlerRegistry(
    definitions: ReadonlyArray<IAgentActionHandlerDefinition<unknown>>,
) {
    return Object.fromEntries(
        definitions.flatMap(definition => definition.ids.map(id => [
            id,
            createAgentActionHandler(definition),
        ])),
    ) as Record<string, IAgentActionHandler>;
}

export const useDocumentWorkspaceAgent = (options: IUseDocumentWorkspaceAgentOptions) => {
    const {
        annotationComments,
        annotationCommentsStatus,
        annotationDirty,
        annotationPlacingPageNote,
        annotationTool,
        bookmarkItems,
        bookmarksDirty,
        canSave,
        closeAllDropdowns,
        closeShapeProperties,
        closeTextMarkupProperties,
        continuousScroll,
        currentPage,
        dragMode,
        enableDragMode,
        fitMode,
        handleActualSize,
        handleAnnotationFocusComment,
        handleAnnotationToolChange,
        handleBookmarksChange,
        handleDeleteAnnotationComment,
        handleDropdownOpen,
        handleExportDocx,
        handleExportImages,
        handleExportMultiPageTiff,
        handleFitMode,
        handleGoToPage,
        handleOpenAnnotationNote,
        handleOpenFileFromUi,
        handlePageLabelRangesUpdate,
        handlePageRotate,
        handlePrint,
        handlePrintCurrentPage,
        handleQuickNoteAction,
        handleSave,
        handleSaveAs,
        handleZoomIn,
        handleZoomOut,
        hasPdf,
        isAnySaving,
        isDjvuMode,
        isSameAnnotationComment,
        markAnnotationDirty,
        ocrPopupOpen,
        ocrPopupRef,
        openConvertDialog,
        originalPath,
        pageLabelRanges,
        pageLabels,
        pageLabelsDirty,
        pageOpsDelete,
        pageOpsExtract,
        pageOpsInsert,
        pdfViewerRef,
        selectedThumbnailPages,
        showConvertDialog,
        showSidebar,
        sidebarTab,
        sortedAnnotationNoteWindows,
        t,
        tabId,
        totalPages,
        updateAnnotationNoteText,
        viewMode,
        workingCopyPath,
        zoom,
    } = options;

    const pageLabelsAgent = createDocumentAgentPageLabels({
        handlePageLabelRangesUpdate,
        pageLabelRanges,
        pageLabels,
        pageLabelsDirty,
        totalPages,
    });
    const bookmarksAgent = createDocumentAgentBookmarks({
        bookmarkItems,
        bookmarksDirty,
        handleBookmarksChange,
        t,
        totalPages,
    });
    const pageImageAgent = createDocumentAgentPageImageCapture({
        currentPage,
        handleGoToPage,
        pdfViewerRef,
        totalPages,
    });
    const annotationsAgent = createDocumentAgentAnnotations({
        annotationComments,
        currentPage,
        isSameAnnotationComment,
        sortedAnnotationNoteWindows,
    });

    const {
        applyAgentPageLabelPlan,
        applyAgentPageLabelsToRange,
        createAgentPageLabelSnapshot,
        getAgentPageLabelRangesInput,
        previewAgentPageLabelPlan,
        setAgentPageLabels,
        updateAgentPageLabelRanges,
    } = pageLabelsAgent;
    const {
        addAgentBookmark,
        addAgentBookmarks,
        applyAgentBookmarkPlan,
        createAgentBookmarkSnapshot,
        deleteAgentBookmark,
        previewAgentBookmarkPlan,
        setAgentBookmarkTree,
        updateAgentBookmark,
    } = bookmarksAgent;
    const { captureAgentPageImage } = pageImageAgent;
    const {
        findAgentAnnotationComment,
        getAgentPointNoteCreateOptions,
        getAgentShapeCreateOptions,
        getAgentTextMarkupCreateOptions,
        normalizeAgentAnnotationComment,
        patchLatestAgentPointNoteMarkerRect,
    } = annotationsAgent;
    const { readAgentResource } = createDocumentAgentResources({
        annotationComments,
        annotationCommentsStatus,
        annotationDirty,
        canSave,
        createAgentBookmarkSnapshot,
        createAgentPageLabelSnapshot,
        currentPage,
        hasPdf,
        isAnySaving,
        normalizeAgentAnnotationComment,
        originalPath,
        sortedAnnotationNoteWindows,
        tabId,
        totalPages,
        workingCopyPath,
    });

    function getAgentOcrRunOptions(input: Record<string, unknown>): IAgentOcrRunOptions {
        const pageRange = getAgentStringInput(input, 'pageRange');
        const customRange = getAgentStringInput(input, 'customRange');
        const languages = getAgentStringArrayInput(input, 'languages')
            ?? getAgentStringArrayInput(input, 'selectedLanguages');
        return {
            ...(isAgentOcrPageRange(pageRange) ? {pageRange} : {}),
            ...(customRange === null ? {} : {customRange}),
            ...(languages === undefined ? {} : {languages}),
            open: true,
        };
    }

    function createAgentActionResult(
        actionId: string,
        extra: object = {},
    ): Record<string, unknown> {
        const payload = extra as Record<string, unknown>;
        return {
            ok: true,
            actionId,
            tabId,
            currentPage: currentPage.value,
            totalPages: totalPages.value,
            ...payload,
        };
    }

    const parseEmptyAgentActionInput = () => undefined;
    const parseAgentActionInput = (input: Record<string, unknown>) => input;

    function parseAgentSidebarTab(input: Record<string, unknown>) {
        const nextTab = getAgentStringInput(input, 'tab') ?? getAgentStringInput(input, 'sidebarTab');
        if (!isAgentSidebarTab(nextTab)) {
            throw new Error('ui.open_sidebar_tab requires input.tab: annotations, bookmarks, thumbnails, or search.');
        }
        return nextTab;
    }

    function parseAgentAnnotationRef(input: Record<string, unknown>) {
        const stableKey = getAgentStringInput(input, 'stableKey');
        const annotationId = getAgentStringInput(input, 'annotationId');
        const id = getAgentStringInput(input, 'id');
        if (stableKey === null && annotationId === null && id === null) {
            throw new Error('Annotation comment was not found. Use evb://document/{tabId}/annotations to get stable keys.');
        }
        return input;
    }

    function parseAgentUpdateNoteInput(input: Record<string, unknown>): IAgentUpdateNoteInput {
        parseAgentAnnotationRef(input);
        const text = getAgentRawStringInput(input, 'text')
            ?? getAgentRawStringInput(input, 'note')
            ?? getAgentRawStringInput(input, 'noteText');
        if (text === null) {
            throw new Error('annotation.update_note requires input.text.');
        }
        return {
            input,
            markerRect: normalizeMarkerRect(
                input.markerRect as IAnnotationCommentSummary['markerRect'],
            ),
            text,
        };
    }

    function parseAgentAnnotationColorInput(input: Record<string, unknown>) {
        parseAgentAnnotationRef(input);
        const color = getAgentStringInput(input, 'color');
        if (!color) {
            throw new Error('annotation.update_text_markup_color requires input.color.');
        }
        return {
            input,
            color,
        };
    }

    function parseAgentAnnotationToolInput(input: Record<string, unknown>) {
        const tool = input.tool;
        if (!isAgentAnnotationTool(tool)) {
            throw new Error('annotation.select_tool requires input.tool to be a supported annotation tool.');
        }
        return tool;
    }

    function parseAgentViewModeInput(input: Record<string, unknown>) {
        const mode = getAgentStringInput(input, 'mode');
        if (mode !== 'single' && mode !== 'facing' && mode !== 'facing-first-single') {
            throw new Error('view.set_mode requires input.mode: single, facing, or facing-first-single.');
        }
        return mode;
    }

    function parseAgentInsertPagesInput(input: Record<string, unknown>) {
        return getAgentNumberInput(input, 'afterPage') ?? totalPages.value;
    }

    function parseAgentPageImageInput(input: Record<string, unknown>, actionId: string) {
        const page = getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber');
        if (page !== null) {
            normalizeAgentPageNumber(page, totalPages.value, actionId);
        }

        const hasExplicitCrop = [
            'x',
            'y',
            'width',
            'height',
        ].some(key => hasAgentInputKey(input, key));
        if (hasExplicitCrop) {
            const x = getAgentNumberInput(input, 'x') ?? 0;
            const y = getAgentNumberInput(input, 'y') ?? 0;
            const width = getAgentNumberInput(input, 'width') ?? 1;
            const height = getAgentNumberInput(input, 'height') ?? 1;
            if (Math.min(1, Math.max(0, x + width)) <= Math.min(1, Math.max(0, x))
                || Math.min(1, Math.max(0, y + height)) <= Math.min(1, Math.max(0, y))) {
                throw new Error('document.capture_page_image crop must have a positive normalized width and height.');
            }
            return input;
        }

        const region = getAgentStringInput(input, 'region') ?? 'full';
        if (![
            'full',
            'top',
            'bottom',
            'left',
            'right',
            'center',
        ].includes(region)) {
            throw new Error('document.capture_page_image region must be full, top, bottom, left, right, or center.');
        }
        return input;
    }

    function parseAgentPageLabelApplyRangeInput(input: Record<string, unknown>, actionId: string) {
        const startPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'startPage') ?? getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber'),
            totalPages.value,
            actionId,
        );
        const endPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'endPage') ?? getAgentNumberInput(input, 'toPage') ?? startPage,
            totalPages.value,
            actionId,
        );
        if (endPage < startPage) {
            throw new Error(`${actionId} endPage must be greater than or equal to startPage.`);
        }
        return input;
    }

    function parseAgentPageLabelSetLabelsInput(input: Record<string, unknown>, actionId: string) {
        if (Array.isArray(input.labels)) {
            return input;
        }
        if (Array.isArray(input.updates)) {
            input.updates
                .filter(isAgentRecord)
                .forEach(update => getAgentPageNumberInput(update, totalPages.value, actionId));
            return input;
        }
        getAgentPageNumberInput(input, totalPages.value, actionId);
        return input;
    }

    function parseAgentBookmarkBatchInput(input: Record<string, unknown>, actionId: string) {
        if (!Array.isArray(input.bookmarks ?? input.items)) {
            throw new Error(`${actionId} requires input.bookmarks or input.items.`);
        }
        return input;
    }

    function parseAgentBookmarkPathInput(input: Record<string, unknown>, actionId: string) {
        const path = getAgentNumberArrayInput(input, 'path');
        if (!path || path.length === 0) {
            throw new Error(`${actionId} requires input.path.`);
        }
        return input;
    }

    function patchAgentAnnotationCommentMarker(
        comment: IAnnotationCommentSummary,
        inputMarkerRect: IAnnotationCommentSummary['markerRect'] | null,
        text: string,
    ) {
        if (!inputMarkerRect) {
            return;
        }
        let matched = false;
        const nextComments = annotationComments.value.map((candidate) => {
            if (
                candidate.stableKey !== comment.stableKey
                && candidate.id !== comment.id
                && (!candidate.annotationId || candidate.annotationId !== comment.annotationId)
            ) {
                return candidate;
            }
            matched = true;
            return {
                ...candidate,
                markerRect: inputMarkerRect,
                text,
                hasNote: true,
            };
        });
        annotationComments.value = matched
            ? nextComments
            : [
                ...nextComments,
                {
                    ...comment,
                    markerRect: inputMarkerRect,
                    text,
                    hasNote: true,
                },
            ];
    }

    const agentActionHandlers = createAgentActionHandlerRegistry([
        {
            ids: ['ui.open_sidebar_tab'],
            parse: parseAgentSidebarTab,
            async run(nextTab: TWorkspaceAgentSidebarTab) {
                showSidebar.value = true;
                sidebarTab.value = nextTab;
                await nextTick();
                return {
                    showSidebar: showSidebar.value,
                    sidebarTab: sidebarTab.value,
                };
            },
        },
        {
            ids: ['ui.toggle_sidebar'],
            parse: parseEmptyAgentActionInput,
            async run() {
                showSidebar.value = !showSidebar.value;
                await nextTick();
                return {showSidebar: showSidebar.value};
            },
        },
        {
            ids: ['ui.close_popups'],
            parse: parseEmptyAgentActionInput,
            async run() {
                closeAllDropdowns();
                closeShapeProperties();
                closeTextMarkupProperties();
                await nextTick();
                return {};
            },
        },
        {
            ids: ['ocr.open_popup'],
            parse: parseEmptyAgentActionInput,
            async run() {
                handleDropdownOpen('ocr', true);
                await nextTick();
                return {ocrPopupOpen: ocrPopupOpen.value};
            },
        },
        {
            ids: ['ocr.status'],
            parse: parseEmptyAgentActionInput,
            run: () => ({
                ocrPopupOpen: ocrPopupOpen.value,
                ocr: ocrPopupRef.value?.getAgentOcrSnapshot() ?? null,
            }),
        },
        {
            ids: ['ocr.start'],
            parse: getAgentOcrRunOptions,
            async run(runOptions: IAgentOcrRunOptions) {
                handleDropdownOpen('ocr', true);
                await nextTick();
                const result = await ocrPopupRef.value?.runOcrForAgent(runOptions);
                return result ?? {
                    ok: false,
                    error: 'OCR popup is not mounted.',
                };
            },
        },
        {
            ids: ['ocr.cancel'],
            parse: parseEmptyAgentActionInput,
            run: () => ocrPopupRef.value?.cancelOcrForAgent() ?? {
                ok: false,
                error: 'OCR popup is not mounted.',
            },
        },
        {
            ids: [
                'document.capture_page_image',
                'document.screenshot_page',
            ],
            parse: parseAgentPageImageInput,
            run: (captureInput: Record<string, unknown>, actionId) => captureAgentPageImage(captureInput, actionId),
        },
        {
            ids: [
                'page_labels.read',
                'page_numbering.read',
            ],
            parse: parseEmptyAgentActionInput,
            run: () => createAgentPageLabelSnapshot(),
        },
        {
            ids: [
                'page_labels.preview',
                'page_numbering.preview',
            ],
            parse: (input, actionId) => previewAgentPageLabelPlan(input, actionId),
            run: (plan: object) => plan,
        },
        {
            ids: [
                'page_labels.apply_plan',
                'page_numbering.apply_plan',
            ],
            parse: (input, actionId) => {
                previewAgentPageLabelPlan(input, actionId);
                return input;
            },
            async run(planInput: Record<string, unknown>, actionId) {
                const snapshot = applyAgentPageLabelPlan(planInput, actionId);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: [
                'page_labels.set_ranges',
                'page_numbering.set_ranges',
            ],
            parse: (input, actionId) => getAgentPageLabelRangesInput(input, actionId),
            async run(ranges: ReturnType<typeof getAgentPageLabelRangesInput>) {
                const snapshot = updateAgentPageLabelRanges(ranges);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: [
                'page_labels.apply_range',
                'page_numbering.apply_range',
            ],
            parse: parseAgentPageLabelApplyRangeInput,
            async run(rangeInput: Record<string, unknown>, actionId) {
                const snapshot = applyAgentPageLabelsToRange(rangeInput, actionId);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: [
                'page_labels.set_labels',
                'page_numbering.set_labels',
            ],
            parse: parseAgentPageLabelSetLabelsInput,
            async run(labelsInput: Record<string, unknown>, actionId) {
                const snapshot = setAgentPageLabels(labelsInput, actionId);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: [
                'page_labels.clear',
                'page_numbering.clear',
            ],
            parse: parseEmptyAgentActionInput,
            async run() {
                const snapshot = updateAgentPageLabelRanges([{
                    startPage: 1,
                    style: 'D',
                    prefix: '',
                    startNumber: 1,
                }]);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.read',
                'toc.read',
            ],
            parse: parseEmptyAgentActionInput,
            run: () => createAgentBookmarkSnapshot(),
        },
        {
            ids: [
                'bookmarks.preview_tree',
                'toc.preview_tree',
            ],
            parse: (input, actionId) => previewAgentBookmarkPlan(input, actionId),
            run: (plan: object) => plan,
        },
        {
            ids: [
                'bookmarks.apply_plan',
                'toc.apply_plan',
            ],
            parse: (input, actionId) => {
                previewAgentBookmarkPlan(input, actionId);
                return input;
            },
            async run(planInput: Record<string, unknown>, actionId) {
                const snapshot = applyAgentBookmarkPlan(planInput, actionId);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.set_tree',
                'toc.set_tree',
            ],
            parse: (input, actionId) => {
                previewAgentBookmarkPlan(input, actionId);
                return input;
            },
            async run(treeInput: Record<string, unknown>, actionId) {
                const snapshot = setAgentBookmarkTree(treeInput, actionId);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.add',
                'toc.add',
            ],
            parse: parseAgentActionInput,
            async run(bookmarkInput: Record<string, unknown>, actionId) {
                const snapshot = addAgentBookmark(bookmarkInput, actionId);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.add_batch',
                'toc.add_batch',
            ],
            parse: parseAgentBookmarkBatchInput,
            async run(bookmarksInput: Record<string, unknown>, actionId) {
                const snapshot = addAgentBookmarks(bookmarksInput, actionId);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.update',
                'toc.update',
            ],
            parse: parseAgentBookmarkPathInput,
            async run(bookmarkInput: Record<string, unknown>, actionId) {
                const snapshot = updateAgentBookmark(bookmarkInput, actionId);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.delete',
                'toc.delete',
            ],
            parse: parseAgentBookmarkPathInput,
            async run(bookmarkInput: Record<string, unknown>, actionId) {
                const snapshot = deleteAgentBookmark(bookmarkInput, actionId);
                await nextTick();
                return snapshot;
            },
        },
        {
            ids: ['annotation.open_note'],
            parse: parseAgentAnnotationRef,
            async run(annotationInput: Record<string, unknown>) {
                const comment = findAgentAnnotationComment(annotationInput);
                handleOpenAnnotationNote(comment);
                await nextTick();
                return {comment: normalizeAgentAnnotationComment(comment)};
            },
        },
        {
            ids: ['annotation.focus'],
            parse: parseAgentAnnotationRef,
            async run(annotationInput: Record<string, unknown>) {
                const comment = findAgentAnnotationComment(annotationInput);
                await handleAnnotationFocusComment(comment);
                return {comment: normalizeAgentAnnotationComment(comment)};
            },
        },
        {
            ids: ['annotation.update_note'],
            parse: parseAgentUpdateNoteInput,
            async run(parsedInput: IAgentUpdateNoteInput) {
                const comment = findAgentAnnotationComment(parsedInput.input);
                const commentForUpdate = parsedInput.markerRect
                    ? {
                        ...comment,
                        markerRect: parsedInput.markerRect,
                        hasNote: true,
                    }
                    : comment;
                patchAgentAnnotationCommentMarker(commentForUpdate, parsedInput.markerRect, parsedInput.text);
                handleOpenAnnotationNote(commentForUpdate);
                await nextTick();
                const openNote = sortedAnnotationNoteWindows.value.find(note =>
                    note.comment.stableKey === commentForUpdate.stableKey
                    || isSameAnnotationComment(note.comment, commentForUpdate),
                );
                const updated = openNote
                    ? true
                    : (pdfViewerRef.value?.updateAnnotationComment(commentForUpdate, parsedInput.text) ?? false);
                if (!updated) {
                    throw new Error('Annotation note could not be updated.');
                }
                if (openNote) {
                    if (parsedInput.markerRect) {
                        const previousComment = openNote.comment;
                        openNote.comment = {
                            ...previousComment,
                            markerRect: parsedInput.markerRect,
                        };
                        annotationComments.value = annotationComments.value.map(candidate => (
                            candidate.stableKey === previousComment.stableKey
                            || isSameAnnotationComment(candidate, previousComment)
                                ? {
                                    ...candidate,
                                    markerRect: parsedInput.markerRect,
                                }
                                : candidate
                        ));
                    }
                    updateAnnotationNoteText(openNote.comment.stableKey, parsedInput.text);
                    markAnnotationDirty();
                }
                await nextTick();
                patchAgentAnnotationCommentMarker(commentForUpdate, parsedInput.markerRect, parsedInput.text);
                await nextTick();
                return {
                    updated,
                    comment: normalizeAgentAnnotationComment({
                        ...commentForUpdate,
                        markerRect: parsedInput.markerRect ?? comment.markerRect,
                        text: parsedInput.text,
                        hasNote: parsedInput.text.trim().length > 0 || comment.hasNote === true,
                    }),
                };
            },
        },
        {
            ids: ['annotation.update_text_markup_color'],
            parse: parseAgentAnnotationColorInput,
            async run(parsedInput: ReturnType<typeof parseAgentAnnotationColorInput>) {
                const comment = findAgentAnnotationComment(parsedInput.input);
                const updated = pdfViewerRef.value?.updateTextMarkupAnnotationColor?.(comment, parsedInput.color) ?? false;
                if (!updated) {
                    throw new Error('Text markup annotation color could not be updated.');
                }
                await nextTick();
                return {
                    updated,
                    comment: normalizeAgentAnnotationComment({
                        ...comment,
                        color: parsedInput.color,
                        colorEdited: true,
                    }),
                };
            },
        },
        {
            ids: ['annotation.delete'],
            parse: parseAgentAnnotationRef,
            async run(annotationInput: Record<string, unknown>) {
                const comment = findAgentAnnotationComment(annotationInput);
                await handleDeleteAnnotationComment(comment);
                return {deletedStableKey: comment.stableKey};
            },
        },
        {
            ids: [
                'annotation.create_note',
                'annotation.start_note_placement',
            ],
            parse: parseEmptyAgentActionInput,
            async run() {
                await handleQuickNoteAction();
                await nextTick();
                return {isPlacingPageNote: annotationPlacingPageNote.value};
            },
        },
        {
            ids: [
                'annotation.create_note_at_point',
                'annotation.place_note',
            ],
            parse: getAgentPointNoteCreateOptions,
            async run(createOptions: ReturnType<typeof getAgentPointNoteCreateOptions>) {
                const result = await pdfViewerRef.value?.createPointNoteAnnotation(createOptions);
                if (!result) {
                    throw new Error('PDF viewer is not ready for annotation.create_note_at_point.');
                }
                await nextTick();
                const markerRect = result.created ? patchLatestAgentPointNoteMarkerRect(createOptions) : null;
                await nextTick();
                return {
                    ...result,
                    markerRect,
                };
            },
        },
        {
            ids: [
                'annotation.select_tool',
                'annotation.set_tool',
            ],
            parse: parseAgentAnnotationToolInput,
            async run(tool: TAnnotationTool) {
                handleAnnotationToolChange(tool);
                await nextTick();
                return {annotationTool: annotationTool.value};
            },
        },
        {
            ids: [
                'annotation.create_text_markup',
                'annotation.mark_text',
            ],
            parse: getAgentTextMarkupCreateOptions,
            async run(createOptions: ReturnType<typeof getAgentTextMarkupCreateOptions>) {
                const result = await pdfViewerRef.value?.createTextMarkupFromText(createOptions);
                if (!result) {
                    throw new Error('PDF viewer is not ready for annotation.create_text_markup.');
                }
                await nextTick();
                return {...result};
            },
        },
        {
            ids: [
                'annotation.create_shape',
                'annotation.draw_shape',
            ],
            parse: getAgentShapeCreateOptions,
            async run(createOptions: ReturnType<typeof getAgentShapeCreateOptions>) {
                const result = await pdfViewerRef.value?.createShapeAnnotation(createOptions);
                if (!result) {
                    throw new Error('PDF viewer is not ready for annotation.create_shape.');
                }
                await nextTick();
                return {
                    ...result,
                    shape: result.shape ? normalizeAgentAnnotationComment(result.shape) : null,
                };
            },
        },
        {
            ids: ['file.save'],
            parse: parseEmptyAgentActionInput,
            async run() {
                const hadPendingSave = canSave.value;
                const saveSucceeded = await handleSave();
                await nextTick();
                if (!saveSucceeded || canSave.value) {
                    throw new Error('Save did not complete; EVB Viewer still reports pending changes.');
                }
                return {
                    saved: hadPendingSave,
                    canSave: canSave.value,
                    workingCopyPath: workingCopyPath.value,
                    originalPath: originalPath.value,
                };
            },
        },
        {
            ids: ['file.save_as'],
            parse: parseEmptyAgentActionInput,
            async run() {
                await handleSaveAs();
                return {};
            },
        },
        {
            ids: ['file.print'],
            parse: parseEmptyAgentActionInput,
            run() {
                handlePrint();
                return {};
            },
        },
        {
            ids: ['file.print_current_page'],
            parse: parseEmptyAgentActionInput,
            async run() {
                await handlePrintCurrentPage();
                return {};
            },
        },
        {
            ids: ['export.docx'],
            parse: parseEmptyAgentActionInput,
            async run() {
                await handleExportDocx();
                return {};
            },
        },
        {
            ids: ['export.images'],
            parse: parseEmptyAgentActionInput,
            async run() {
                await handleExportImages();
                return {};
            },
        },
        {
            ids: ['export.multi_page_tiff'],
            parse: parseEmptyAgentActionInput,
            async run() {
                await handleExportMultiPageTiff();
                return {};
            },
        },
        {
            ids: ['view.zoom_in'],
            parse: parseEmptyAgentActionInput,
            run() {
                handleZoomIn();
                return {zoom: zoom.value};
            },
        },
        {
            ids: ['view.zoom_out'],
            parse: parseEmptyAgentActionInput,
            run() {
                handleZoomOut();
                return {zoom: zoom.value};
            },
        },
        {
            ids: ['view.fit_width'],
            parse: parseEmptyAgentActionInput,
            run() {
                handleFitMode('width');
                return {fitMode: fitMode.value};
            },
        },
        {
            ids: ['view.fit_height'],
            parse: parseEmptyAgentActionInput,
            run() {
                handleFitMode('height');
                return {fitMode: fitMode.value};
            },
        },
        {
            ids: ['view.actual_size'],
            parse: parseEmptyAgentActionInput,
            run() {
                handleActualSize();
                return {zoom: zoom.value};
            },
        },
        {
            ids: ['view.toggle_continuous_scroll'],
            parse: parseEmptyAgentActionInput,
            run() {
                continuousScroll.value = !continuousScroll.value;
                return {continuousScroll: continuousScroll.value};
            },
        },
        {
            ids: ['view.enable_drag_mode'],
            parse: parseEmptyAgentActionInput,
            run() {
                enableDragMode();
                return {dragMode: dragMode.value};
            },
        },
        {
            ids: ['view.disable_drag_mode'],
            parse: parseEmptyAgentActionInput,
            run() {
                handleAnnotationToolChange('none');
                return {dragMode: dragMode.value};
            },
        },
        {
            ids: ['view.set_mode'],
            parse: parseAgentViewModeInput,
            run(mode: ReturnType<typeof parseAgentViewModeInput>) {
                viewMode.value = mode;
                return {viewMode: viewMode.value};
            },
        },
        {
            ids: ['page_ops.delete_selected'],
            parse: parseEmptyAgentActionInput,
            async run() {
                await pageOpsDelete(selectedThumbnailPages.value, totalPages.value);
                return {selectedPages: selectedThumbnailPages.value};
            },
        },
        {
            ids: ['page_ops.extract_selected'],
            parse: parseEmptyAgentActionInput,
            async run() {
                await pageOpsExtract(selectedThumbnailPages.value);
                return {selectedPages: selectedThumbnailPages.value};
            },
        },
        {
            ids: ['page_ops.rotate_cw_selected'],
            parse: parseEmptyAgentActionInput,
            async run() {
                await handlePageRotate(selectedThumbnailPages.value, 90);
                return {selectedPages: selectedThumbnailPages.value};
            },
        },
        {
            ids: ['page_ops.rotate_ccw_selected'],
            parse: parseEmptyAgentActionInput,
            async run() {
                await handlePageRotate(selectedThumbnailPages.value, 270);
                return {selectedPages: selectedThumbnailPages.value};
            },
        },
        {
            ids: ['page_ops.insert_pages'],
            parse: parseAgentInsertPagesInput,
            async run(afterPage: number) {
                await pageOpsInsert(totalPages.value, afterPage);
                return {};
            },
        },
        {
            ids: ['page_ops.convert_to_pdf'],
            parse: parseEmptyAgentActionInput,
            async run() {
                if (isDjvuMode.value) {
                    openConvertDialog();
                } else {
                    await handleOpenFileFromUi();
                }
                return {showConvertDialog: showConvertDialog.value};
            },
        },
    ]);

    async function runAgentAction(
        actionId: string,
        input: Record<string, unknown> | undefined = {},
        options: {dryRun?: boolean} = {},
    ): Promise<Record<string, unknown>> {
        if (!isAgentRecord(input)) {
            throw new Error('Agent action input must be an object.');
        }
        const handler = agentActionHandlers[actionId];
        if (!handler) {
            throw new Error(`Unsupported EVB agent action: ${actionId}`);
        }
        const parsedInput = handler.parse(input, actionId);
        if (options.dryRun) {
            return createAgentActionResult(actionId, {
                dryRun: true,
                wouldRun: true,
            });
        }

        return createAgentActionResult(actionId, await handler.run(parsedInput, actionId));
    }

    return {
        runAgentAction,
        readAgentResource,
    };
};
