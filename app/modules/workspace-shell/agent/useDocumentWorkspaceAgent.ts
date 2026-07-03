import type { TAnnotationTool } from '@app/types/annotations';
import { isAgentRecord } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import type {
    IAgentOcrRunOptions,
    IUseDocumentWorkspaceAgentOptions,
    TWorkspaceAgentSidebarTab,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';
import type { IWorkspaceAgentCommandContext } from '@app/types/workspaceExpose';
import { createDocumentAgentAnnotations } from '@app/modules/workspace-shell/agent/createDocumentAgentAnnotations';
import { createDocumentAgentAnnotationNoteActions } from '@app/modules/workspace-shell/agent/createDocumentAgentAnnotationNoteActions';
import { createDocumentAgentBookmarks } from '@app/modules/workspace-shell/agent/createDocumentAgentBookmarks';
import { createDocumentAgentFilePageHistoryActions } from '@app/modules/workspace-shell/agent/createDocumentAgentFilePageHistoryActions';
import { createDocumentAgentPageImageCapture } from '@app/modules/workspace-shell/agent/createDocumentAgentPageImageCapture';
import { createDocumentAgentPageLabels } from '@app/modules/workspace-shell/agent/createDocumentAgentPageLabels';
import { createDocumentAgentResources } from '@app/modules/workspace-shell/agent/createDocumentAgentResources';
import {
    createAgentActionHandlerRegistry,
    type IAgentActionExecutionPolicy,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentActionRegistry';
import { createDocumentWorkspaceAgentParsers } from '@app/modules/workspace-shell/agent/createDocumentWorkspaceAgentParsers';

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
    'bookmarks.delete_batch',
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
    'file.repair_save',
    'file.optimize_for_interaction',
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
    'page_ops.crop',
    'page_ops.remove_crop',
    'page_ops.insert_pages',
    'page_ops.convert_to_pdf',
    'history.undo',
    'history.redo',
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
    'toc.delete_batch',
    'annotation.start_note_placement',
    'annotation.place_note',
    'annotation.set_tool',
    'annotation.mark_text',
    'annotation.draw_shape',
] as const;

export const DOCUMENT_WORKSPACE_AGENT_ACTION_IDS = [
    ...DOCUMENT_WORKSPACE_AGENT_PRIMARY_ACTION_IDS,
    ...DOCUMENT_WORKSPACE_AGENT_ALIAS_ACTION_IDS,
] as const;

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
        canUndo,
        canRedo,
        closeAllDropdowns,
        closeShapeProperties,
        closeTextMarkupProperties,
        continuousScroll,
        currentPage,
        documentIdentity,
        fitMode,
        handleActualSize,
        handleAnnotationFocusComment,
        handleAnnotationToolChange,
        handleBookmarksChange,
        updateTextMarkupColorWithHistory,
        handleDeleteAnnotationComment,
        handleDropdownOpen,
        handleExportDocx,
        handleExportImages,
        handleExportMultiPageTiff,
        handleFitMode,
        handleGoToPage,
        handleOpenAnnotationNote,
        handleOpenFileFromUi,
        handleRepairSave,
        handleOptimizePdfForInteraction,
        handleUndo,
        handleRedo,
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
        handleCropPages,
        handleRemoveCrop,
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
        waitForDocumentOpenSettled,
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
        deleteAgentBookmarks,
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
    const { readAgentResource: readDocumentAgentResource } = createDocumentAgentResources({
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
    const {
        getAgentOcrRunOptions,
        parseAgentActionInput,
        parseAgentAnnotationRef,
        parseAgentAnnotationToolInput,
        parseAgentBookmarkBatchInput,
        parseAgentBookmarkPathBatchInput,
        parseAgentBookmarkPathInput,
        parseAgentInsertPagesInput,
        parseAgentPageImageInput,
        parseAgentPageLabelApplyRangeInput,
        parseAgentPageLabelSetLabelsInput,
        parseAgentSidebarTab,
        parseAgentViewModeInput,
        parseEmptyAgentActionInput,
    } = createDocumentWorkspaceAgentParsers({ totalPages });

    async function waitForAgentMutationStateSettled() {
        await nextTick();
        await nextTick();
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

    function createDjvuPageOperationBlockedResult() {
        return {
            ok: false,
            blocked: true,
            reason: 'djvu-page-operations-disabled',
            requiredAction: 'page_ops.convert_to_pdf',
        };
    }

    function createAgentCommandAbortError() {
        const error = new Error('Agent command was aborted.');
        error.name = 'AbortError';
        return error;
    }

    function assertDocumentIdentityMatches(
        expected: IWorkspaceAgentCommandContext['documentIdentity'],
        allowRevisionChange: boolean,
    ) {
        if (!expected) {
            return;
        }

        const current = documentIdentity.value;
        const matches = allowRevisionChange
            ? current?.documentRef === expected.documentRef
            : current?.documentRef === expected.documentRef && current.token === expected.token;
        if (!matches) {
            throw new Error('Agent command target document changed.');
        }
    }

    function assertAgentCommandContext(
        context: IWorkspaceAgentCommandContext | undefined,
        policy?: IAgentActionExecutionPolicy,
        allowRevisionChange = false,
    ) {
        if (!context) {
            return;
        }

        if (context.signal.aborted) {
            throw createAgentCommandAbortError();
        }
        if (policy?.cancelsOnDocumentChange === false) {
            return;
        }
        if (!allowRevisionChange) {
            context.assertCurrentDocument();
        }
        assertDocumentIdentityMatches(context.documentIdentity, allowRevisionChange);
    }

    function createGuardedAgentCommandContext(
        context: IWorkspaceAgentCommandContext | undefined,
        policy: IAgentActionExecutionPolicy,
    ): IWorkspaceAgentCommandContext | undefined {
        if (!context) {
            return undefined;
        }

        return {
            ...context,
            assertCurrentDocument: () => {
                assertAgentCommandContext(context, policy);
            },
        };
    }

    async function runPdfPageOperationAgentAction(
        run: () => Promise<object>,
        context?: IWorkspaceAgentCommandContext,
    ) {
        if (isDjvuMode.value) {
            return createDjvuPageOperationBlockedResult();
        }
        context?.assertCurrentDocument();
        return run();
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
            policy: {mutatesDocument: true},
            parse: getAgentOcrRunOptions,
            async run(runOptions: IAgentOcrRunOptions, _actionId, context) {
                handleDropdownOpen('ocr', true);
                await nextTick();
                context?.assertCurrentDocument();
                const result = await ocrPopupRef.value?.runOcrForAgent(runOptions);
                return result ?? {
                    ok: false,
                    error: 'OCR popup is not mounted.',
                };
            },
        },
        {
            ids: ['ocr.cancel'],
            policy: {mutatesDocument: true},
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                context?.assertCurrentDocument();
                const result = await ocrPopupRef.value?.cancelOcrForAgent();
                return result ?? {
                    ok: false,
                    error: 'OCR popup is not mounted.',
                };
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
            policy: {mutatesDocument: true},
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
            policy: {mutatesDocument: true},
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
            policy: {mutatesDocument: true},
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
            policy: {mutatesDocument: true},
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
            policy: {mutatesDocument: true},
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
            parse: parseAgentActionInput,
            async run(input: Record<string, unknown>, actionId, context) {
                await waitForDocumentOpenSettled();
                context?.assertCurrentDocument();
                return previewAgentBookmarkPlan(input, actionId);
            },
        },
        {
            ids: [
                'bookmarks.apply_plan',
                'toc.apply_plan',
            ],
            policy: {mutatesDocument: true},
            parse: parseAgentActionInput,
            async run(planInput: Record<string, unknown>, actionId, context) {
                await waitForDocumentOpenSettled();
                context?.assertCurrentDocument();
                const snapshot = applyAgentBookmarkPlan(planInput, actionId);
                await waitForAgentMutationStateSettled();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.set_tree',
                'toc.set_tree',
            ],
            policy: {mutatesDocument: true},
            parse: parseAgentActionInput,
            async run(treeInput: Record<string, unknown>, actionId, context) {
                await waitForDocumentOpenSettled();
                context?.assertCurrentDocument();
                const snapshot = setAgentBookmarkTree(treeInput, actionId);
                await waitForAgentMutationStateSettled();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.add',
                'toc.add',
            ],
            policy: {mutatesDocument: true},
            parse: parseAgentActionInput,
            async run(bookmarkInput: Record<string, unknown>, actionId) {
                const snapshot = addAgentBookmark(bookmarkInput, actionId);
                await waitForAgentMutationStateSettled();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.add_batch',
                'toc.add_batch',
            ],
            policy: {mutatesDocument: true},
            parse: parseAgentBookmarkBatchInput,
            async run(bookmarksInput: Record<string, unknown>, actionId) {
                const snapshot = addAgentBookmarks(bookmarksInput, actionId);
                await waitForAgentMutationStateSettled();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.update',
                'toc.update',
            ],
            policy: {mutatesDocument: true},
            parse: parseAgentBookmarkPathInput,
            async run(bookmarkInput: Record<string, unknown>, actionId) {
                const snapshot = updateAgentBookmark(bookmarkInput, actionId);
                await waitForAgentMutationStateSettled();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.delete',
                'toc.delete',
            ],
            policy: {mutatesDocument: true},
            parse: parseAgentBookmarkPathInput,
            async run(bookmarkInput: Record<string, unknown>, actionId) {
                const snapshot = deleteAgentBookmark(bookmarkInput, actionId);
                await waitForAgentMutationStateSettled();
                return snapshot;
            },
        },
        {
            ids: [
                'bookmarks.delete_batch',
                'toc.delete_batch',
            ],
            policy: {mutatesDocument: true},
            parse: parseAgentBookmarkPathBatchInput,
            async run(bookmarksInput: Record<string, unknown>, actionId) {
                const snapshot = deleteAgentBookmarks(bookmarksInput, actionId);
                await waitForAgentMutationStateSettled();
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
        ...createDocumentAgentAnnotationNoteActions({
            annotationComments,
            findAgentAnnotationComment,
            handleOpenAnnotationNote,
            isSameAnnotationComment,
            markAnnotationDirty,
            normalizeAgentAnnotationComment,
            pdfViewerRef,
            sortedAnnotationNoteWindows,
            updateAnnotationNoteText,
            updateTextMarkupColorWithHistory,
        }),
        {
            ids: ['annotation.delete'],
            policy: {mutatesDocument: true},
            parse: parseAgentAnnotationRef,
            async run(annotationInput: Record<string, unknown>, _actionId, context) {
                const comment = findAgentAnnotationComment(annotationInput);
                context?.assertCurrentDocument();
                await handleDeleteAnnotationComment(comment);
                return {deletedStableKey: comment.stableKey};
            },
        },
        {
            ids: [
                'annotation.create_note',
                'annotation.start_note_placement',
            ],
            policy: {mutatesDocument: true},
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                context?.assertCurrentDocument();
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
            policy: {mutatesDocument: true},
            parse: getAgentPointNoteCreateOptions,
            async run(createOptions: ReturnType<typeof getAgentPointNoteCreateOptions>, _actionId, context) {
                context?.assertCurrentDocument();
                const result = await pdfViewerRef.value?.createPointNoteAnnotation(createOptions);
                if (!result) {
                    throw new Error('PDF viewer is not ready for annotation.create_note_at_point.');
                }
                await nextTick();
                context?.assertCurrentDocument();
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
            policy: {mutatesDocument: true},
            parse: getAgentTextMarkupCreateOptions,
            async run(createOptions: ReturnType<typeof getAgentTextMarkupCreateOptions>, _actionId, context) {
                context?.assertCurrentDocument();
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
            policy: {mutatesDocument: true},
            parse: getAgentShapeCreateOptions,
            async run(createOptions: ReturnType<typeof getAgentShapeCreateOptions>, _actionId, context) {
                context?.assertCurrentDocument();
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
            policy: {mutatesDocument: true},
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                await waitForAgentMutationStateSettled();
                context?.assertCurrentDocument();
                const hadPendingSave = canSave.value;
                const saveSucceeded = await handleSave();
                await waitForAgentMutationStateSettled();
                if (!saveSucceeded || canSave.value) {
                    throw new Error(`Save did not complete; EVB Viewer still reports pending changes. ${JSON.stringify({
                        annotationDirty: annotationDirty.value,
                        bookmarksDirty: bookmarksDirty.value,
                        canSave: canSave.value,
                        pageLabelsDirty: pageLabelsDirty.value,
                        saveSucceeded,
                    })}`);
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
            policy: {mutatesDocument: true},
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                context?.assertCurrentDocument();
                await handleSaveAs();
                return {};
            },
        },
        ...createDocumentAgentFilePageHistoryActions({
            canRedo,
            canSave,
            canUndo,
            handleCropPages,
            handleOptimizePdfForInteraction,
            handleRedo,
            handleRemoveCrop,
            handleRepairSave,
            handleUndo,
            originalPath,
            runPdfPageOperationAgentAction,
            totalPages,
            waitForAgentMutationStateSettled,
            workingCopyPath,
        }),
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
            async run(_input, _actionId, context) {
                context?.assertCurrentDocument();
                await handleExportDocx();
                return {};
            },
        },
        {
            ids: ['export.images'],
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                context?.assertCurrentDocument();
                await handleExportImages();
                return {};
            },
        },
        {
            ids: ['export.multi_page_tiff'],
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                context?.assertCurrentDocument();
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
            ids: ['view.set_mode'],
            parse: parseAgentViewModeInput,
            run(mode: ReturnType<typeof parseAgentViewModeInput>) {
                viewMode.value = mode;
                return {viewMode: viewMode.value};
            },
        },
        {
            ids: ['page_ops.delete_selected'],
            policy: {mutatesDocument: true},
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                return runPdfPageOperationAgentAction(async () => {
                    await pageOpsDelete(selectedThumbnailPages.value, totalPages.value);
                    return {selectedPages: selectedThumbnailPages.value};
                }, context);
            },
        },
        {
            ids: ['page_ops.extract_selected'],
            policy: {mutatesDocument: true},
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                return runPdfPageOperationAgentAction(async () => {
                    await pageOpsExtract(selectedThumbnailPages.value);
                    return {selectedPages: selectedThumbnailPages.value};
                }, context);
            },
        },
        {
            ids: ['page_ops.rotate_cw_selected'],
            policy: {mutatesDocument: true},
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                return runPdfPageOperationAgentAction(async () => {
                    await handlePageRotate(selectedThumbnailPages.value, 90);
                    return {selectedPages: selectedThumbnailPages.value};
                }, context);
            },
        },
        {
            ids: ['page_ops.rotate_ccw_selected'],
            policy: {mutatesDocument: true},
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                return runPdfPageOperationAgentAction(async () => {
                    await handlePageRotate(selectedThumbnailPages.value, 270);
                    return {selectedPages: selectedThumbnailPages.value};
                }, context);
            },
        },
        {
            ids: ['page_ops.insert_pages'],
            policy: {mutatesDocument: true},
            parse: parseAgentInsertPagesInput,
            async run(afterPage: number, _actionId, context) {
                return runPdfPageOperationAgentAction(async () => {
                    await pageOpsInsert(totalPages.value, afterPage);
                    return {};
                }, context);
            },
        },
        {
            ids: ['page_ops.convert_to_pdf'],
            policy: {mutatesDocument: true},
            parse: parseEmptyAgentActionInput,
            async run(_input, _actionId, context) {
                context?.assertCurrentDocument();
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
        actionOptions: {dryRun?: boolean} = {},
        context?: IWorkspaceAgentCommandContext,
    ): Promise<Record<string, unknown>> {
        assertAgentCommandContext(context);
        if (!isAgentRecord(input)) {
            throw new Error('Agent action input must be an object.');
        }
        const handler = agentActionHandlers[actionId];
        if (!handler) {
            throw new Error(`Unsupported EVB agent action: ${actionId}`);
        }
        const parsedAction = handler.parse(input, actionId);
        const guardedContext = createGuardedAgentCommandContext(context, parsedAction.policy);
        assertAgentCommandContext(context, parsedAction.policy);
        if (actionOptions.dryRun) {
            return createAgentActionResult(actionId, {
                dryRun: true,
                wouldRun: true,
            });
        }

        const result = await parsedAction.run(guardedContext);
        assertAgentCommandContext(context, parsedAction.policy, parsedAction.policy.mutatesDocument);
        return createAgentActionResult(actionId, result);
    }

    async function readAgentResource(
        uri: string,
        context?: IWorkspaceAgentCommandContext,
    ): Promise<Record<string, unknown>> {
        assertAgentCommandContext(context);
        const result = await readDocumentAgentResource(uri);
        assertAgentCommandContext(context);
        return result;
    }

    return {
        runAgentAction,
        readAgentResource,
    };
};
