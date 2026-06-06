import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';
import {
    getAgentNumberInput,
    getAgentRawStringInput,
    getAgentStringArrayInput,
    getAgentStringInput,
    isAgentAnnotationTool,
    isAgentOcrPageRange,
    isAgentRecord,
    isAgentSidebarTab,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentInputs';
import type {
    IAgentOcrRunOptions,
    IUseDocumentWorkspaceAgentOptions,
} from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';
import { createDocumentAgentAnnotations } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentAnnotations';
import { createDocumentAgentBookmarks } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentBookmarks';
import { createDocumentAgentPageImageCapture } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPageImage';
import { createDocumentAgentPageLabels } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentPageLabels';
import { createDocumentAgentResources } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentResources';

export type { IOcrPopupAgentExpose } from '@app/modules/workspace-shell/agent/documentWorkspaceAgentTypes';

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

    async function runAgentAction(
        actionId: string,
        input: Record<string, unknown> | undefined = {},
        options: {dryRun?: boolean} = {},
    ): Promise<Record<string, unknown>> {
        if (!isAgentRecord(input)) {
            throw new Error('Agent action input must be an object.');
        }
        if (options.dryRun) {
            return createAgentActionResult(actionId, {
                dryRun: true,
                wouldRun: true,
            });
        }

        switch (actionId) {
            case 'ui.open_sidebar_tab': {
                const nextTab = getAgentStringInput(input, 'tab') ?? getAgentStringInput(input, 'sidebarTab');
                if (!isAgentSidebarTab(nextTab)) {
                    throw new Error('ui.open_sidebar_tab requires input.tab: annotations, bookmarks, thumbnails, or search.');
                }
                showSidebar.value = true;
                sidebarTab.value = nextTab;
                await nextTick();
                return createAgentActionResult(actionId, {
                    showSidebar: showSidebar.value,
                    sidebarTab: sidebarTab.value,
                });
            }
            case 'ui.toggle_sidebar':
                showSidebar.value = !showSidebar.value;
                await nextTick();
                return createAgentActionResult(actionId, {showSidebar: showSidebar.value});
            case 'ui.close_popups':
                closeAllDropdowns();
                closeShapeProperties();
                closeTextMarkupProperties();
                await nextTick();
                return createAgentActionResult(actionId);
            case 'ocr.open_popup':
                handleDropdownOpen('ocr', true);
                await nextTick();
                return createAgentActionResult(actionId, {ocrPopupOpen: ocrPopupOpen.value});
            case 'ocr.status':
                return createAgentActionResult(actionId, {
                    ocrPopupOpen: ocrPopupOpen.value,
                    ocr: ocrPopupRef.value?.getAgentOcrSnapshot() ?? null,
                });
            case 'ocr.start': {
                handleDropdownOpen('ocr', true);
                await nextTick();
                const result = await ocrPopupRef.value?.runOcrForAgent(getAgentOcrRunOptions(input));
                if (!result) {
                    return createAgentActionResult(actionId, {
                        ok: false,
                        error: 'OCR popup is not mounted.',
                    });
                }
                return createAgentActionResult(actionId, result);
            }
            case 'ocr.cancel':
                return createAgentActionResult(actionId, ocrPopupRef.value?.cancelOcrForAgent() ?? {
                    ok: false,
                    error: 'OCR popup is not mounted.',
                });
            case 'document.capture_page_image':
            case 'document.screenshot_page': {
                const result = await captureAgentPageImage(input, actionId);
                return createAgentActionResult(actionId, result);
            }
            case 'page_labels.read':
            case 'page_numbering.read':
                return createAgentActionResult(actionId, createAgentPageLabelSnapshot());
            case 'page_labels.preview':
            case 'page_numbering.preview':
                return createAgentActionResult(actionId, previewAgentPageLabelPlan(input, actionId));
            case 'page_labels.apply_plan':
            case 'page_numbering.apply_plan': {
                const snapshot = applyAgentPageLabelPlan(input, actionId);
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'page_labels.set_ranges':
            case 'page_numbering.set_ranges': {
                const snapshot = updateAgentPageLabelRanges(getAgentPageLabelRangesInput(input, actionId));
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'page_labels.apply_range':
            case 'page_numbering.apply_range': {
                const snapshot = applyAgentPageLabelsToRange(input, actionId);
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'page_labels.set_labels':
            case 'page_numbering.set_labels': {
                const snapshot = setAgentPageLabels(input, actionId);
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'page_labels.clear':
            case 'page_numbering.clear': {
                const snapshot = updateAgentPageLabelRanges([{
                    startPage: 1,
                    style: 'D',
                    prefix: '',
                    startNumber: 1,
                }]);
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'bookmarks.read':
            case 'toc.read':
                return createAgentActionResult(actionId, createAgentBookmarkSnapshot());
            case 'bookmarks.preview_tree':
            case 'toc.preview_tree':
                return createAgentActionResult(actionId, previewAgentBookmarkPlan(input, actionId));
            case 'bookmarks.apply_plan':
            case 'toc.apply_plan': {
                const snapshot = applyAgentBookmarkPlan(input, actionId);
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'bookmarks.set_tree':
            case 'toc.set_tree': {
                const snapshot = setAgentBookmarkTree(input, actionId);
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'bookmarks.add':
            case 'toc.add': {
                const snapshot = addAgentBookmark(input, actionId);
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'bookmarks.add_batch':
            case 'toc.add_batch': {
                const snapshot = addAgentBookmarks(input, actionId);
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'bookmarks.update':
            case 'toc.update': {
                const snapshot = updateAgentBookmark(input, actionId);
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'bookmarks.delete':
            case 'toc.delete': {
                const snapshot = deleteAgentBookmark(input, actionId);
                await nextTick();
                return createAgentActionResult(actionId, snapshot);
            }
            case 'annotation.open_note': {
                const comment = findAgentAnnotationComment(input);
                handleOpenAnnotationNote(comment);
                await nextTick();
                return createAgentActionResult(actionId, {comment: normalizeAgentAnnotationComment(comment)});
            }
            case 'annotation.focus': {
                const comment = findAgentAnnotationComment(input);
                await handleAnnotationFocusComment(comment);
                return createAgentActionResult(actionId, {comment: normalizeAgentAnnotationComment(comment)});
            }
            case 'annotation.update_note': {
                const comment = findAgentAnnotationComment(input);
                const text = getAgentRawStringInput(input, 'text')
                    ?? getAgentRawStringInput(input, 'note')
                    ?? getAgentRawStringInput(input, 'noteText');
                if (text === null) {
                    throw new Error('annotation.update_note requires input.text.');
                }
                const inputMarkerRect = normalizeMarkerRect(
                    input.markerRect as IAnnotationCommentSummary['markerRect'],
                );
                const commentForUpdate = inputMarkerRect
                    ? {
                        ...comment,
                        markerRect: inputMarkerRect,
                        hasNote: true,
                    }
                    : comment;
                const patchAnnotationCommentMarker = () => {
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
                                ...commentForUpdate,
                                markerRect: inputMarkerRect,
                                text,
                                hasNote: true,
                            },
                        ];
                };
                patchAnnotationCommentMarker();
                handleOpenAnnotationNote(commentForUpdate);
                await nextTick();
                const openNote = sortedAnnotationNoteWindows.value.find(note =>
                    note.comment.stableKey === commentForUpdate.stableKey
                    || isSameAnnotationComment(note.comment, commentForUpdate),
                );
                const updated = openNote
                    ? true
                    : (pdfViewerRef.value?.updateAnnotationComment(commentForUpdate, text) ?? false);
                if (!updated) {
                    throw new Error('Annotation note could not be updated.');
                }
                if (openNote) {
                    if (inputMarkerRect) {
                        const previousComment = openNote.comment;
                        openNote.comment = {
                            ...previousComment,
                            markerRect: inputMarkerRect,
                        };
                        annotationComments.value = annotationComments.value.map(candidate => (
                            candidate.stableKey === previousComment.stableKey
                            || isSameAnnotationComment(candidate, previousComment)
                                ? {
                                    ...candidate,
                                    markerRect: inputMarkerRect,
                                }
                                : candidate
                        ));
                    }
                    updateAnnotationNoteText(openNote.comment.stableKey, text);
                    markAnnotationDirty();
                }
                await nextTick();
                patchAnnotationCommentMarker();
                await nextTick();
                return createAgentActionResult(actionId, {
                    updated,
                    comment: normalizeAgentAnnotationComment({
                        ...commentForUpdate,
                        markerRect: inputMarkerRect ?? comment.markerRect,
                        text,
                        hasNote: text.trim().length > 0 || comment.hasNote === true,
                    }),
                });
            }
            case 'annotation.update_text_markup_color': {
                const comment = findAgentAnnotationComment(input);
                const color = getAgentStringInput(input, 'color');
                if (!color) {
                    throw new Error('annotation.update_text_markup_color requires input.color.');
                }
                const updated = pdfViewerRef.value?.updateTextMarkupAnnotationColor?.(comment, color) ?? false;
                if (!updated) {
                    throw new Error('Text markup annotation color could not be updated.');
                }
                await nextTick();
                return createAgentActionResult(actionId, {
                    updated,
                    comment: normalizeAgentAnnotationComment({
                        ...comment,
                        color,
                        colorEdited: true,
                    }),
                });
            }
            case 'annotation.delete': {
                const comment = findAgentAnnotationComment(input);
                await handleDeleteAnnotationComment(comment);
                return createAgentActionResult(actionId, {deletedStableKey: comment.stableKey});
            }
            case 'annotation.create_note':
            case 'annotation.start_note_placement':
                await handleQuickNoteAction();
                await nextTick();
                return createAgentActionResult(actionId, {isPlacingPageNote: annotationPlacingPageNote.value});
            case 'annotation.create_note_at_point':
            case 'annotation.place_note': {
                const options = getAgentPointNoteCreateOptions(input);
                const result = await pdfViewerRef.value?.createPointNoteAnnotation(options);
                if (!result) {
                    throw new Error('PDF viewer is not ready for annotation.create_note_at_point.');
                }
                await nextTick();
                const markerRect = result.created ? patchLatestAgentPointNoteMarkerRect(options) : null;
                await nextTick();
                return createAgentActionResult(actionId, {
                    ...result,
                    markerRect,
                });
            }
            case 'annotation.select_tool':
            case 'annotation.set_tool': {
                const tool = input.tool;
                if (!isAgentAnnotationTool(tool)) {
                    throw new Error('annotation.select_tool requires input.tool to be a supported annotation tool.');
                }
                handleAnnotationToolChange(tool);
                await nextTick();
                return createAgentActionResult(actionId, {annotationTool: annotationTool.value});
            }
            case 'annotation.create_text_markup':
            case 'annotation.mark_text': {
                const result = await pdfViewerRef.value?.createTextMarkupFromText(
                    getAgentTextMarkupCreateOptions(input),
                );
                if (!result) {
                    throw new Error('PDF viewer is not ready for annotation.create_text_markup.');
                }
                await nextTick();
                return createAgentActionResult(actionId, {...result});
            }
            case 'annotation.create_shape':
            case 'annotation.draw_shape': {
                const result = await pdfViewerRef.value?.createShapeAnnotation(
                    getAgentShapeCreateOptions(input),
                );
                if (!result) {
                    throw new Error('PDF viewer is not ready for annotation.create_shape.');
                }
                await nextTick();
                return createAgentActionResult(actionId, {
                    ...result,
                    shape: result.shape ? normalizeAgentAnnotationComment(result.shape) : null,
                });
            }
            case 'file.save': {
                const hadPendingSave = canSave.value;
                const saveSucceeded = await handleSave();
                await nextTick();
                if (!saveSucceeded || canSave.value) {
                    throw new Error('Save did not complete; EVB Viewer still reports pending changes.');
                }
                return createAgentActionResult(actionId, {
                    saved: hadPendingSave,
                    canSave: canSave.value,
                    workingCopyPath: workingCopyPath.value,
                    originalPath: originalPath.value,
                });
            }
            case 'file.save_as':
                await handleSaveAs();
                return createAgentActionResult(actionId);
            case 'file.print':
                handlePrint();
                return createAgentActionResult(actionId);
            case 'file.print_current_page':
                await handlePrintCurrentPage();
                return createAgentActionResult(actionId);
            case 'export.docx':
                await handleExportDocx();
                return createAgentActionResult(actionId);
            case 'export.images':
                await handleExportImages();
                return createAgentActionResult(actionId);
            case 'export.multi_page_tiff':
                await handleExportMultiPageTiff();
                return createAgentActionResult(actionId);
            case 'view.zoom_in':
                handleZoomIn();
                return createAgentActionResult(actionId, {zoom: zoom.value});
            case 'view.zoom_out':
                handleZoomOut();
                return createAgentActionResult(actionId, {zoom: zoom.value});
            case 'view.fit_width':
                handleFitMode('width');
                return createAgentActionResult(actionId, {fitMode: fitMode.value});
            case 'view.fit_height':
                handleFitMode('height');
                return createAgentActionResult(actionId, {fitMode: fitMode.value});
            case 'view.actual_size':
                handleActualSize();
                return createAgentActionResult(actionId, {zoom: zoom.value});
            case 'view.toggle_continuous_scroll':
                continuousScroll.value = !continuousScroll.value;
                return createAgentActionResult(actionId, {continuousScroll: continuousScroll.value});
            case 'view.enable_drag_mode':
                enableDragMode();
                return createAgentActionResult(actionId, {dragMode: dragMode.value});
            case 'view.disable_drag_mode':
                handleAnnotationToolChange('none');
                return createAgentActionResult(actionId, {dragMode: dragMode.value});
            case 'view.set_mode': {
                const mode = getAgentStringInput(input, 'mode');
                if (mode !== 'single' && mode !== 'facing' && mode !== 'facing-first-single') {
                    throw new Error('view.set_mode requires input.mode: single, facing, or facing-first-single.');
                }
                viewMode.value = mode;
                return createAgentActionResult(actionId, {viewMode: viewMode.value});
            }
            case 'page_ops.delete_selected':
                await pageOpsDelete(selectedThumbnailPages.value, totalPages.value);
                return createAgentActionResult(actionId, {selectedPages: selectedThumbnailPages.value});
            case 'page_ops.extract_selected':
                await pageOpsExtract(selectedThumbnailPages.value);
                return createAgentActionResult(actionId, {selectedPages: selectedThumbnailPages.value});
            case 'page_ops.rotate_cw_selected':
                await handlePageRotate(selectedThumbnailPages.value, 90);
                return createAgentActionResult(actionId, {selectedPages: selectedThumbnailPages.value});
            case 'page_ops.rotate_ccw_selected':
                await handlePageRotate(selectedThumbnailPages.value, 270);
                return createAgentActionResult(actionId, {selectedPages: selectedThumbnailPages.value});
            case 'page_ops.insert_pages':
                await pageOpsInsert(totalPages.value, getAgentNumberInput(input, 'afterPage') ?? totalPages.value);
                return createAgentActionResult(actionId);
            case 'page_ops.convert_to_pdf':
                if (isDjvuMode.value) {
                    openConvertDialog();
                } else {
                    await handleOpenFileFromUi();
                }
                return createAgentActionResult(actionId, {showConvertDialog: showConvertDialog.value});
            default:
                throw new Error(`Unsupported EVB agent action: ${actionId}`);
        }
    }

    return {
        runAgentAction,
        readAgentResource,
    };
};
