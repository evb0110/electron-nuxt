import type { Ref } from 'vue';
import { delay } from 'es-toolkit/promise';
import type { TDocumentRef } from '@contracts/platformApi';
import type { TPdfViewMode } from '@contracts/shared';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPageLabelStyle,
} from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    IShapePoint,
    TAnnotationCommentsStatus,
    TAnnotationTool,
    TDrawableShapeType,
} from '@app/types/annotations';
import type { IAnnotationNoteWindowState } from '@app/utils/pdf-viewer/annotations/annotationNoteWindowTypes';
import type { TAgentTextMarkupKind } from '@app/composables/pdf/annotations/useAnnotationHighlight';
import { markerRectFromPoint } from '@app/utils/pdf-viewer/annotations/pdf-page-point-resolver/markerRectFromPoint';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';
import {
    buildPageLabelsFromRanges,
    derivePageLabelRangesFromLabels,
} from '@app/utils/pdfPageLabels';
import { normalizeBookmarkColor } from '@app/utils/pdfOutlineHelpers';
import {
    createAgentBookmarkPlan,
    createAgentBookmarkSnapshot as createAgentBookmarkPlanSnapshot,
    createAgentPageLabelPlan,
    createAgentPageLabelSnapshot as createAgentPageLabelPlanSnapshot,
} from '@app/utils/agentMetadataPlans';
import { capturePdfRegionAsPngBlob } from '@app/utils/pdf-viewer/pdf-region-capture/capturePdfRegionAsPngBlob';
import { getRectHeight } from '@app/utils/pdf-viewer/pdf-region-geometry/getRectHeight';
import { getRectWidth } from '@app/utils/pdf-viewer/pdf-region-geometry/getRectWidth';
import type { IClientRect } from '@app/utils/pdf-viewer/pdf-region-geometry/pdfRegionGeometryTypes';
import { toClientRect } from '@app/utils/pdf-viewer/pdf-region-geometry/toClientRect';
import {
    findPdfPageContainer,
    pdfViewerDomSelectors,
} from '@app/modules/pdf-viewer/public';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';

type TWorkspaceAgentSidebarTab = 'annotations' | 'bookmarks' | 'thumbnails' | 'search';
type TWorkspaceAgentFitMode = 'width' | 'height';
type TWorkspaceAgentRotateAngle = 90 | 180 | 270;

type TWorkspaceAgentTranslate = (key: 'bookmarks.untitled') => string;

export interface IOcrPopupAgentExpose {
    runOcrForAgent: (options?: IAgentOcrRunOptions) => Promise<Record<string, unknown>>;
    cancelOcrForAgent: () => Record<string, unknown>;
    getAgentOcrSnapshot: () => Record<string, unknown>;
}

interface IUseDocumentWorkspaceAgentOptions {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    annotationCommentsStatus: Ref<TAnnotationCommentsStatus>;
    annotationDirty: Ref<boolean>;
    annotationPlacingPageNote: Ref<boolean>;
    annotationTool: Ref<TAnnotationTool>;
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    bookmarksDirty: Ref<boolean>;
    canSave: Ref<boolean>;
    closeAllDropdowns: () => void;
    closeShapeProperties: () => void;
    closeTextMarkupProperties: () => void;
    continuousScroll: Ref<boolean>;
    currentPage: Ref<number>;
    dragMode: Ref<boolean>;
    enableDragMode: () => void;
    fitMode: Ref<unknown>;
    handleActualSize: () => void;
    handleAnnotationFocusComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
    handleBookmarksChange: (payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }) => void;
    handleDeleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    handleDropdownOpen: (dropdown: 'ocr', open: boolean) => void;
    handleExportDocx: () => Promise<unknown>;
    handleExportImages: () => Promise<unknown>;
    handleExportMultiPageTiff: () => Promise<unknown>;
    handleFitMode: (mode: TWorkspaceAgentFitMode) => void;
    handleGoToPage: (page: number) => void;
    handleOpenAnnotationNote: (comment: IAnnotationCommentSummary) => void;
    handleOpenFileFromUi: () => Promise<unknown>;
    handlePageLabelRangesUpdate: (ranges: IPdfPageLabelRange[]) => void;
    handlePageRotate: (pages: number[], degrees: TWorkspaceAgentRotateAngle) => Promise<unknown>;
    handlePrint: () => void;
    handlePrintCurrentPage: () => Promise<unknown>;
    handleQuickNoteAction: () => Promise<unknown>;
    handleSave: () => Promise<boolean>;
    handleSaveAs: () => Promise<unknown>;
    handleZoomIn: () => void;
    handleZoomOut: () => void;
    hasPdf: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isDjvuMode: Ref<boolean>;
    isSameAnnotationComment: (left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) => boolean;
    markAnnotationDirty: () => void;
    ocrPopupOpen: Ref<boolean>;
    ocrPopupRef: Ref<IOcrPopupAgentExpose | null>;
    openConvertDialog: () => void;
    originalPath: Ref<TDocumentRef | null>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    pageLabels: Ref<string[] | null>;
    pageLabelsDirty: Ref<boolean>;
    pageOpsDelete: (pages: number[], totalPages: number) => Promise<unknown>;
    pageOpsExtract: (pages: number[]) => Promise<unknown>;
    pageOpsInsert: (totalPages: number, afterPage: number) => Promise<unknown>;
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    selectedThumbnailPages: Ref<number[]>;
    showConvertDialog: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TWorkspaceAgentSidebarTab>;
    sortedAnnotationNoteWindows: Ref<IAnnotationNoteWindowState[]>;
    t: TWorkspaceAgentTranslate;
    tabId: string;
    totalPages: Ref<number>;
    updateAnnotationNoteText: (stableKey: string, text: string) => void;
    viewMode: Ref<TPdfViewMode>;
    workingCopyPath: Ref<TDocumentRef | null>;
    zoom: Ref<number>;
}

export type TAgentOcrPageRange = 'all' | 'current' | 'custom';

export interface IAgentOcrRunOptions {
    pageRange?: TAgentOcrPageRange;
    customRange?: string;
    languages?: string[];
    open?: boolean;
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

    const AGENT_ANNOTATION_TOOLS = [
        'none',
        'select',
        'highlight',
        'underline',
        'strikethrough',
        'squiggly',
        'text',
        'draw',
        'rectangle',
        'circle',
        'line',
        'arrow',
        'stamp',
    ] as const satisfies readonly TAnnotationTool[];
    const AGENT_SIDEBAR_TABS = [
        'annotations',
        'bookmarks',
        'thumbnails',
        'search',
    ] as const;
    const AGENT_TEXT_MARKUP_KINDS = [
        'highlight',
        'underline',
        'strikethrough',
        'squiggly',
    ] as const satisfies readonly TAgentTextMarkupKind[];

    const AGENT_SHAPE_TOOLS = [
        'draw',
        'rectangle',
        'circle',
        'line',
        'arrow',
    ] as const satisfies readonly TDrawableShapeType[];
    const AGENT_PAGE_IMAGE_REGIONS = [
        'full',
        'top',
        'bottom',
        'left',
        'right',
        'center',
    ] as const;
    const AGENT_PAGE_IMAGE_RENDER_TIMEOUT_MS = 3_000;
    const AGENT_PAGE_IMAGE_RENDER_POLL_MS = 50;

    const AGENT_PAGE_LABEL_STYLES = [
        'D',
        'R',
        'r',
        'A',
        'a',
    ] as const satisfies ReadonlyArray<Exclude<TPageLabelStyle, null>>;

    function isAgentRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    function getAgentStringInput(input: Record<string, unknown> | undefined, key: string) {
        const value = input?.[key];
        return typeof value === 'string' && value.trim().length > 0
            ? value.trim()
            : null;
    }

    function getAgentRawStringInput(input: Record<string, unknown> | undefined, key: string) {
        const value = input?.[key];
        return typeof value === 'string' ? value : null;
    }

    function getAgentNumberInput(input: Record<string, unknown> | undefined, key: string) {
        const value = input?.[key];
        return typeof value === 'number' && Number.isFinite(value)
            ? value
            : null;
    }

    function getAgentBooleanInput(input: Record<string, unknown> | undefined, key: string) {
        const value = input?.[key];
        return typeof value === 'boolean' ? value : null;
    }

    function getAgentStringArrayInput(input: Record<string, unknown> | undefined, key: string) {
        const value = input?.[key];
        if (!Array.isArray(value)) {
            return undefined;
        }
        const strings = value
            .filter((item): item is string => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean);
        return strings.length > 0 ? Array.from(new Set(strings)) : undefined;
    }

    function getAgentNumberArrayInput(input: Record<string, unknown> | undefined, key: string) {
        const value = input?.[key];
        if (!Array.isArray(value)) {
            return undefined;
        }
        const numbers = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
        return numbers.length === value.length ? numbers : undefined;
    }

    function hasAgentInputKey(input: Record<string, unknown>, key: string) {
        return Object.prototype.hasOwnProperty.call(input, key);
    }

    function isAgentAnnotationTool(value: unknown): value is TAnnotationTool {
        return typeof value === 'string' && AGENT_ANNOTATION_TOOLS.includes(value as TAnnotationTool);
    }

    function isAgentSidebarTab(value: unknown): value is typeof AGENT_SIDEBAR_TABS[number] {
        return typeof value === 'string' && AGENT_SIDEBAR_TABS.includes(value as typeof AGENT_SIDEBAR_TABS[number]);
    }

    function isAgentTextMarkupKind(value: unknown): value is TAgentTextMarkupKind {
        return typeof value === 'string' && AGENT_TEXT_MARKUP_KINDS.includes(value as TAgentTextMarkupKind);
    }

    function isAgentShapeTool(value: unknown): value is TDrawableShapeType {
        return typeof value === 'string' && AGENT_SHAPE_TOOLS.includes(value as TDrawableShapeType);
    }

    function isAgentPageLabelStyle(value: unknown): value is Exclude<TPageLabelStyle, null> {
        return typeof value === 'string' && AGENT_PAGE_LABEL_STYLES.includes(value as Exclude<TPageLabelStyle, null>);
    }

    function isAgentOcrPageRange(value: unknown): value is TAgentOcrPageRange {
        return value === 'all' || value === 'current' || value === 'custom';
    }

    function isAgentPageImageRegion(value: unknown): value is typeof AGENT_PAGE_IMAGE_REGIONS[number] {
        return typeof value === 'string' && AGENT_PAGE_IMAGE_REGIONS.includes(value as typeof AGENT_PAGE_IMAGE_REGIONS[number]);
    }

    function getAgentNullableStringInput(input: Record<string, unknown> | undefined, key: string) {
        const value = input?.[key];
        if (value === null) {
            return null;
        }
        return typeof value === 'string' ? value.trim() : undefined;
    }

    function getAgentPointInput(value: unknown): IShapePoint | null {
        if (!isAgentRecord(value)) {
            return null;
        }
        const x = getAgentNumberInput(value, 'x') ?? getAgentNumberInput(value, 'pageX');
        const y = getAgentNumberInput(value, 'y') ?? getAgentNumberInput(value, 'pageY');
        if (x === null || y === null) {
            return null;
        }
        return {
            x,
            y,
        };
    }

    function getAgentPointArrayInput(input: Record<string, unknown>, key: string) {
        const value = input[key];
        if (!Array.isArray(value)) {
            return undefined;
        }
        const points = value
            .map(getAgentPointInput)
            .filter((point): point is IShapePoint => point !== null);
        return points.length > 0 ? points : undefined;
    }

    function getAgentStrokeArrayInput(input: Record<string, unknown>, key: string) {
        const value = input[key];
        if (!Array.isArray(value)) {
            return undefined;
        }
        const strokes = value
            .filter(Array.isArray)
            .map(points => points
                .map(getAgentPointInput)
                .filter((point): point is IShapePoint => point !== null))
            .filter(points => points.length > 0);
        return strokes.length > 0 ? strokes : undefined;
    }

    function requireAgentPdfPageCount(actionId: string) {
        if (totalPages.value <= 0) {
            throw new Error(`${actionId} requires an open PDF document.`);
        }
        return totalPages.value;
    }

    function normalizeAgentPageNumber(value: number | null | undefined, actionId: string) {
        const pageCount = requireAgentPdfPageCount(actionId);
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(`${actionId} requires a valid one-based page number.`);
        }
        const page = Math.trunc(value);
        if (page < 1 || page > pageCount) {
            throw new Error(`${actionId} page ${page} is outside the document.`);
        }
        return page;
    }

    function getAgentPageNumberInput(input: Record<string, unknown>, actionId: string) {
        return normalizeAgentPageNumber(
            getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber'),
            actionId,
        );
    }

    function getAgentOptionalPageNumberInput(input: Record<string, unknown>, actionId: string) {
        return normalizeAgentPageNumber(
            getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber') ?? currentPage.value,
            actionId,
        );
    }

    function normalizeAgentUnit(value: number | null | undefined, fallback: number) {
        const normalizedValue = typeof value === 'number' && Number.isFinite(value)
            ? value
            : fallback;
        return Math.min(1, Math.max(0, normalizedValue));
    }

    function normalizeAgentPositiveUnit(value: number | null | undefined, fallback: number) {
        const normalizedValue = normalizeAgentUnit(value, fallback);
        return normalizedValue > 0 ? normalizedValue : fallback;
    }

    function getAgentPageImageSelection(input: Record<string, unknown>, pageRect: IClientRect) {
        const pageWidth = getRectWidth(pageRect);
        const pageHeight = getRectHeight(pageRect);
        const hasExplicitCrop = [
            'x',
            'y',
            'width',
            'height',
        ].some(key => hasAgentInputKey(input, key));

        if (hasExplicitCrop) {
            const x = normalizeAgentUnit(getAgentNumberInput(input, 'x'), 0);
            const y = normalizeAgentUnit(getAgentNumberInput(input, 'y'), 0);
            const width = normalizeAgentPositiveUnit(getAgentNumberInput(input, 'width'), 1);
            const height = normalizeAgentPositiveUnit(getAgentNumberInput(input, 'height'), 1);
            const right = normalizeAgentUnit(x + width, 1);
            const bottom = normalizeAgentUnit(y + height, 1);
            if (right <= x || bottom <= y) {
                throw new Error('document.capture_page_image crop must have a positive normalized width and height.');
            }
            return {
                left: pageRect.left + x * pageWidth,
                top: pageRect.top + y * pageHeight,
                right: pageRect.left + right * pageWidth,
                bottom: pageRect.top + bottom * pageHeight,
            };
        }

        const region = getAgentStringInput(input, 'region') ?? 'full';
        if (!isAgentPageImageRegion(region)) {
            throw new Error('document.capture_page_image region must be full, top, bottom, left, right, or center.');
        }

        switch (region) {
            case 'top':
                return {
                    ...pageRect,
                    bottom: pageRect.top + pageHeight * 0.35,
                };
            case 'bottom':
                return {
                    ...pageRect,
                    top: pageRect.bottom - pageHeight * 0.35,
                };
            case 'left':
                return {
                    ...pageRect,
                    right: pageRect.left + pageWidth * 0.5,
                };
            case 'right':
                return {
                    ...pageRect,
                    left: pageRect.right - pageWidth * 0.5,
                };
            case 'center':
                return {
                    left: pageRect.left + pageWidth * 0.2,
                    top: pageRect.top + pageHeight * 0.2,
                    right: pageRect.right - pageWidth * 0.2,
                    bottom: pageRect.bottom - pageHeight * 0.2,
                };
            case 'full':
                return pageRect;
        }
    }

    function findAgentRenderedPageElement(viewerContainer: HTMLElement, pageNumber: number) {
        const pageElement = findPdfPageContainer(viewerContainer, pageNumber);
        const canvas = pageElement?.querySelector<HTMLCanvasElement>(pdfViewerDomSelectors.pageCanvasElement) ?? null;
        if (!pageElement || !canvas || canvas.width <= 0 || canvas.height <= 0) {
            return null;
        }
        return pageElement;
    }

    async function waitForAgentRenderedPageElement(viewerContainer: HTMLElement, pageNumber: number) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < AGENT_PAGE_IMAGE_RENDER_TIMEOUT_MS) {
            const pageElement = findAgentRenderedPageElement(viewerContainer, pageNumber);
            if (pageElement) {
                return pageElement;
            }
            await delay(AGENT_PAGE_IMAGE_RENDER_POLL_MS);
            await nextTick();
        }

        throw new Error(`document.capture_page_image could not find a rendered canvas for page ${pageNumber}.`);
    }

    function bytesToBase64(bytes: Uint8Array) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
    }

    async function blobToBase64(blob: Blob) {
        return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    }

    function createAgentCaptureRectMetadata(rect: IClientRect, pageRect: IClientRect) {
        const pageWidth = getRectWidth(pageRect);
        const pageHeight = getRectHeight(pageRect);
        return {
            x: pageWidth > 0 ? (rect.left - pageRect.left) / pageWidth : 0,
            y: pageHeight > 0 ? (rect.top - pageRect.top) / pageHeight : 0,
            width: pageWidth > 0 ? getRectWidth(rect) / pageWidth : 0,
            height: pageHeight > 0 ? getRectHeight(rect) / pageHeight : 0,
        };
    }

    async function captureAgentPageImage(input: Record<string, unknown>, actionId: string) {
        const pageNumber = getAgentOptionalPageNumberInput(input, actionId);
        const viewer = pdfViewerRef.value;
        const viewerContainer = viewer?.getViewerContainer?.() ?? null;
        if (!viewer || !viewerContainer) {
            throw new Error('document.capture_page_image requires a rendered PDF viewer.');
        }

        handleGoToPage(pageNumber);
        viewer.scrollToPage(pageNumber);
        await viewer.ensurePageMetricsInRange?.(pageNumber, pageNumber);
        await nextTick();

        const pageElement = await waitForAgentRenderedPageElement(viewerContainer, pageNumber);
        const pageRect = toClientRect(pageElement.getBoundingClientRect());
        const selectionRect = getAgentPageImageSelection(input, pageRect);
        const capture = await capturePdfRegionAsPngBlob(viewerContainer, selectionRect);
        if (!capture) {
            throw new Error(`document.capture_page_image could not capture page ${pageNumber}.`);
        }

        return {
            pageNumber,
            crop: createAgentCaptureRectMetadata(capture.outputRect, pageRect),
            image: {
                mimeType: 'image/png',
                sizeBytes: capture.blob.size,
                data: await blobToBase64(capture.blob),
            },
        };
    }

    function normalizeAgentBookmarkPageIndex(input: Record<string, unknown>, actionId: string) {
        const pageNumber = getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber');
        if (pageNumber !== null) {
            return normalizeAgentPageNumber(pageNumber, actionId) - 1;
        }

        const pageIndex = getAgentNumberInput(input, 'pageIndex');
        if (pageIndex === null) {
            return null;
        }
        const normalizedPageIndex = Math.trunc(pageIndex);
        if (normalizedPageIndex < 0 || normalizedPageIndex >= requireAgentPdfPageCount(actionId)) {
            throw new Error(`${actionId} pageIndex ${normalizedPageIndex} is outside the document.`);
        }
        return normalizedPageIndex;
    }

    function normalizeAgentPageLabelStyle(value: unknown): TPageLabelStyle {
        if (value === null) {
            return null;
        }
        if (isAgentPageLabelStyle(value)) {
            return value;
        }
        if (typeof value !== 'string') {
            return 'D';
        }

        switch (value.trim().toLowerCase()) {
            case 'decimal':
            case 'number':
            case 'numbers':
            case 'arabic':
                return 'D';
            case 'roman':
            case 'roman-upper':
            case 'uppercase-roman':
                return 'R';
            case 'roman-lower':
            case 'lowercase-roman':
                return 'r';
            case 'letters':
            case 'letters-upper':
            case 'alpha':
            case 'alpha-upper':
            case 'uppercase-alpha':
                return 'A';
            case 'letters-lower':
            case 'alpha-lower':
            case 'lowercase-alpha':
                return 'a';
            case 'literal':
            case 'none':
            case 'prefix':
            case '':
                return null;
            default:
                return 'D';
        }
    }

    function normalizeAgentPageLabelRange(input: Record<string, unknown>, actionId: string): IPdfPageLabelRange {
        return {
            startPage: getAgentPageNumberInput(input, actionId),
            style: normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
            prefix: getAgentRawStringInput(input, 'prefix') ?? '',
            startNumber: Math.max(1, Math.trunc(
                getAgentNumberInput(input, 'startNumber')
                ?? getAgentNumberInput(input, 'number')
                ?? 1,
            )),
        };
    }

    function getEffectiveAgentPageLabels() {
        const pageCount = totalPages.value;
        if (pageCount <= 0) {
            return [];
        }
        if (pageLabels.value && pageLabels.value.length === pageCount) {
            return pageLabels.value;
        }
        return buildPageLabelsFromRanges(pageCount, pageLabelRanges.value);
    }

    function createAgentPageLabelSnapshot() {
        return createAgentPageLabelPlanSnapshot({
            totalPages: totalPages.value,
            dirty: pageLabelsDirty.value,
            pageLabelRanges: pageLabelRanges.value,
            pageLabels: pageLabels.value,
        });
    }

    function updateAgentPageLabelRanges(ranges: IPdfPageLabelRange[]) {
        handlePageLabelRangesUpdate(ranges);
        return createAgentPageLabelSnapshot();
    }

    function getAgentPageLabelRangesInput(input: Record<string, unknown>, actionId: string) {
        const rawRanges = input.ranges;
        if (!Array.isArray(rawRanges)) {
            throw new Error(`${actionId} requires input.ranges.`);
        }
        return rawRanges
            .filter(isAgentRecord)
            .map(range => normalizeAgentPageLabelRange(range, actionId));
    }

    function getAgentPageLabelApplyRangeOptions(input: Record<string, unknown>, actionId: string) {
        const startPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'startPage') ?? getAgentNumberInput(input, 'page') ?? getAgentNumberInput(input, 'pageNumber'),
            actionId,
        );
        const endPage = normalizeAgentPageNumber(
            getAgentNumberInput(input, 'endPage') ?? getAgentNumberInput(input, 'toPage') ?? startPage,
            actionId,
        );
        if (endPage < startPage) {
            throw new Error(`${actionId} endPage must be greater than or equal to startPage.`);
        }
        return {
            startPage,
            endPage,
            style: normalizeAgentPageLabelStyle(input.style ?? input.numberStyle ?? input.format),
            prefix: getAgentRawStringInput(input, 'prefix') ?? '',
            startNumber: Math.max(1, Math.trunc(
                getAgentNumberInput(input, 'startNumber')
                ?? getAgentNumberInput(input, 'number')
                ?? 1,
            )),
        };
    }

    function applyAgentPageLabelsToRange(input: Record<string, unknown>, actionId: string) {
        const {
            startPage,
            endPage,
            style,
            prefix,
            startNumber,
        } = getAgentPageLabelApplyRangeOptions(input, actionId);
        const labels = [...getEffectiveAgentPageLabels()];
        const segmentLabels = buildPageLabelsFromRanges(
            endPage - startPage + 1,
            [{
                startPage: 1,
                style,
                prefix,
                startNumber,
            }],
        );
        segmentLabels.forEach((label, index) => {
            labels[startPage - 1 + index] = label;
        });
        return updateAgentPageLabelRanges(derivePageLabelRangesFromLabels(labels, totalPages.value));
    }

    function setAgentPageLabels(input: Record<string, unknown>, actionId: string) {
        const pageCount = requireAgentPdfPageCount(actionId);
        const labels = [...getEffectiveAgentPageLabels()];
        const rawLabels = input.labels;
        if (Array.isArray(rawLabels)) {
            rawLabels.slice(0, pageCount).forEach((label, index) => {
                labels[index] = typeof label === 'string' ? label : '';
            });
        }

        const updates = input.updates;
        if (Array.isArray(updates)) {
            updates
                .filter(isAgentRecord)
                .forEach((update) => {
                    const page = getAgentPageNumberInput(update, actionId);
                    labels[page - 1] = getAgentRawStringInput(update, 'label') ?? '';
                });
        }

        if (!Array.isArray(rawLabels) && !Array.isArray(updates)) {
            const page = getAgentPageNumberInput(input, actionId);
            labels[page - 1] = getAgentRawStringInput(input, 'label') ?? '';
        }

        return updateAgentPageLabelRanges(derivePageLabelRangesFromLabels(labels, totalPages.value));
    }

    function previewAgentPageLabelPlan(input: Record<string, unknown>, actionId: string) {
        return createAgentPageLabelPlan({
            input,
            totalPages: totalPages.value,
            currentRanges: pageLabelRanges.value,
            currentLabels: pageLabels.value,
            dirty: pageLabelsDirty.value,
            actionId,
        });
    }

    function applyAgentPageLabelPlan(input: Record<string, unknown>, actionId: string) {
        const plan = previewAgentPageLabelPlan(input, actionId);
        const snapshot = updateAgentPageLabelRanges(plan.ranges);
        return {
            ...snapshot,
            plan,
        };
    }

    function cloneAgentBookmarkEntry(bookmark: IPdfBookmarkEntry): IPdfBookmarkEntry {
        return {
            ...bookmark,
            items: bookmark.items.map(cloneAgentBookmarkEntry),
        };
    }

    function cloneAgentBookmarks() {
        return bookmarkItems.value.map(cloneAgentBookmarkEntry);
    }

    function getAgentBookmarkPathInput(input: Record<string, unknown>, key = 'path') {
        const path = getAgentNumberArrayInput(input, key);
        return path?.map(index => Math.max(0, Math.trunc(index))) ?? null;
    }

    function getBookmarkListAtPath(
        bookmarks: IPdfBookmarkEntry[],
        path: number[],
        actionId: string,
    ) {
        let list = bookmarks;
        for (const index of path) {
            const bookmark = list[index];
            if (!bookmark) {
                throw new Error(`${actionId} bookmark path was not found.`);
            }
            list = bookmark.items;
        }
        return list;
    }

    function getBookmarkLocationAtPath(
        bookmarks: IPdfBookmarkEntry[],
        path: number[] | null,
        actionId: string,
    ) {
        if (!path || path.length === 0) {
            throw new Error(`${actionId} requires input.path.`);
        }
        const parentPath = path.slice(0, -1);
        const index = path[path.length - 1]!;
        const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
        const bookmark = list[index];
        if (!bookmark) {
            throw new Error(`${actionId} bookmark path was not found.`);
        }
        return {
            list,
            index,
            bookmark,
        };
    }

    function normalizeAgentBookmarkEntry(input: Record<string, unknown>, actionId: string): IPdfBookmarkEntry {
        const title = getAgentRawStringInput(input, 'title')?.trim() || t('bookmarks.untitled');
        const namedDest = getAgentRawStringInput(input, 'namedDest')
            ?? getAgentRawStringInput(input, 'dest')
            ?? null;
        const items = Array.isArray(input.items)
            ? input.items
                .filter(isAgentRecord)
                .map(item => normalizeAgentBookmarkEntry(item, actionId))
            : [];
        const color = getAgentNullableStringInput(input, 'color');
        return {
            title,
            pageIndex: normalizeAgentBookmarkPageIndex(input, actionId),
            namedDest: namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null,
            bold: getAgentBooleanInput(input, 'bold') ?? false,
            italic: getAgentBooleanInput(input, 'italic') ?? false,
            color: color === null ? null : normalizeBookmarkColor(color),
            items,
        };
    }

    function normalizeAgentBookmarkInput(input: Record<string, unknown>, actionId: string) {
        const rawBookmark = input.bookmark;
        return normalizeAgentBookmarkEntry(
            isAgentRecord(rawBookmark) ? rawBookmark : input,
            actionId,
        );
    }

    function createAgentBookmarkSnapshot() {
        return createAgentBookmarkPlanSnapshot(bookmarkItems.value, {dirty: bookmarksDirty.value});
    }

    function updateAgentBookmarks(bookmarks: IPdfBookmarkEntry[]) {
        handleBookmarksChange({
            bookmarks,
            dirty: true,
        });
        return createAgentBookmarkSnapshot();
    }

    function setAgentBookmarkTree(input: Record<string, unknown>, actionId: string) {
        const plan = previewAgentBookmarkPlan(input, actionId);
        return {
            ...updateAgentBookmarks(plan.bookmarks),
            plan,
        };
    }

    function previewAgentBookmarkPlan(input: Record<string, unknown>, actionId: string) {
        return createAgentBookmarkPlan({
            input,
            currentBookmarks: bookmarkItems.value,
            totalPages: totalPages.value,
            dirty: bookmarksDirty.value,
            untitledTitle: t('bookmarks.untitled'),
            actionId,
        });
    }

    function applyAgentBookmarkPlan(input: Record<string, unknown>, actionId: string) {
        const plan = previewAgentBookmarkPlan(input, actionId);
        return {
            ...updateAgentBookmarks(plan.bookmarks),
            plan,
        };
    }

    function addAgentBookmark(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const parentPath = getAgentBookmarkPathInput(input, 'parentPath') ?? [];
        const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
        const bookmark = normalizeAgentBookmarkInput(input, actionId);
        const index = getAgentNumberInput(input, 'index');
        const insertIndex = index === null
            ? list.length
            : Math.min(list.length, Math.max(0, Math.trunc(index)));
        list.splice(insertIndex, 0, bookmark);
        return updateAgentBookmarks(bookmarks);
    }

    function addAgentBookmarks(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const batchParentPath = getAgentBookmarkPathInput(input, 'parentPath') ?? [];
        const rawItems = input.bookmarks ?? input.items;
        if (!Array.isArray(rawItems)) {
            throw new Error(`${actionId} requires input.bookmarks or input.items.`);
        }

        rawItems
            .filter(isAgentRecord)
            .forEach((item) => {
                const parentPath = getAgentBookmarkPathInput(item, 'parentPath') ?? batchParentPath;
                const list = getBookmarkListAtPath(bookmarks, parentPath, actionId);
                const insertIndex = getAgentNumberInput(item, 'index');
                const bookmark = normalizeAgentBookmarkEntry(item, actionId);
                list.splice(
                    insertIndex === null ? list.length : Math.min(list.length, Math.max(0, Math.trunc(insertIndex))),
                    0,
                    bookmark,
                );
            });
        return updateAgentBookmarks(bookmarks);
    }

    function updateAgentBookmark(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const location = getBookmarkLocationAtPath(bookmarks, getAgentBookmarkPathInput(input), actionId);
        const bookmarkUpdates = isAgentRecord(input.bookmark) ? input.bookmark : input;
        const updated = {...location.bookmark};
        if (hasAgentInputKey(bookmarkUpdates, 'title')) {
            updated.title = getAgentRawStringInput(bookmarkUpdates, 'title')?.trim() || t('bookmarks.untitled');
        }
        if (
            hasAgentInputKey(bookmarkUpdates, 'page')
            || hasAgentInputKey(bookmarkUpdates, 'pageNumber')
            || hasAgentInputKey(bookmarkUpdates, 'pageIndex')
        ) {
            updated.pageIndex = normalizeAgentBookmarkPageIndex(bookmarkUpdates, actionId);
        }
        if (hasAgentInputKey(bookmarkUpdates, 'namedDest') || hasAgentInputKey(bookmarkUpdates, 'dest')) {
            const namedDest = getAgentRawStringInput(bookmarkUpdates, 'namedDest')
                ?? getAgentRawStringInput(bookmarkUpdates, 'dest')
                ?? null;
            updated.namedDest = namedDest && namedDest.trim().length > 0 ? namedDest.trim() : null;
        }
        if (hasAgentInputKey(bookmarkUpdates, 'bold')) {
            updated.bold = getAgentBooleanInput(bookmarkUpdates, 'bold') ?? false;
        }
        if (hasAgentInputKey(bookmarkUpdates, 'italic')) {
            updated.italic = getAgentBooleanInput(bookmarkUpdates, 'italic') ?? false;
        }
        if (hasAgentInputKey(bookmarkUpdates, 'color')) {
            const color = getAgentNullableStringInput(bookmarkUpdates, 'color');
            updated.color = color === null ? null : normalizeBookmarkColor(color);
        }
        if (Array.isArray(bookmarkUpdates.items)) {
            updated.items = bookmarkUpdates.items
                .filter(isAgentRecord)
                .map(item => normalizeAgentBookmarkEntry(item, actionId));
        }
        location.list.splice(location.index, 1, updated);
        return updateAgentBookmarks(bookmarks);
    }

    function deleteAgentBookmark(input: Record<string, unknown>, actionId: string) {
        const bookmarks = cloneAgentBookmarks();
        const location = getBookmarkLocationAtPath(bookmarks, getAgentBookmarkPathInput(input), actionId);
        location.list.splice(location.index, 1);
        return updateAgentBookmarks(bookmarks);
    }

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

    function getAgentTextMarkupCreateOptions(input: Record<string, unknown>) {
        const text = getAgentStringInput(input, 'text')
            ?? getAgentStringInput(input, 'query')
            ?? getAgentStringInput(input, 'selectionText');
        if (!text) {
            throw new Error('annotation.create_text_markup requires input.text.');
        }

        const pageNumber = getAgentNumberInput(input, 'page')
            ?? getAgentNumberInput(input, 'pageNumber')
            ?? currentPage.value;
        const occurrence = getAgentNumberInput(input, 'occurrence')
            ?? getAgentNumberInput(input, 'matchIndex')
            ?? 1;
        const markup = getAgentStringInput(input, 'markup')
            ?? getAgentStringInput(input, 'tool')
            ?? getAgentStringInput(input, 'kind');
        const withNote = getAgentBooleanInput(input, 'withNote')
            ?? getAgentBooleanInput(input, 'openNote')
            ?? false;
        const caseSensitive = getAgentBooleanInput(input, 'caseSensitive')
            ?? getAgentBooleanInput(input, 'matchCase')
            ?? false;
        const wholeWord = getAgentBooleanInput(input, 'wholeWord') ?? false;

        if (!isAgentTextMarkupKind(markup ?? 'highlight')) {
            throw new Error('annotation.create_text_markup requires input.markup: highlight, underline, strikethrough, or squiggly.');
        }

        return {
            pageNumber,
            text,
            occurrence,
            markup: (markup ?? 'highlight') as TAgentTextMarkupKind,
            caseSensitive,
            wholeWord,
            withNote,
        };
    }

    function getAgentPointNoteCreateOptions(input: Record<string, unknown>) {
        const pageNumber = getAgentNumberInput(input, 'page')
            ?? getAgentNumberInput(input, 'pageNumber')
            ?? currentPage.value;
        const pageX = getAgentNumberInput(input, 'pageX') ?? getAgentNumberInput(input, 'x');
        const pageY = getAgentNumberInput(input, 'pageY') ?? getAgentNumberInput(input, 'y');
        if (pageX === null || pageY === null) {
            throw new Error('annotation.create_note_at_point requires input.pageX and input.pageY.');
        }

        return {
            pageNumber,
            pageX,
            pageY,
            preferTextAnchor: getAgentBooleanInput(input, 'preferTextAnchor') ?? true,
        };
    }

    function patchLatestAgentPointNoteMarkerRect(options: ReturnType<typeof getAgentPointNoteCreateOptions>) {
        const markerRect = markerRectFromPoint(options.pageX, options.pageY);
        if (!markerRect) {
            return null;
        }
        const pageNumber = Math.max(1, Math.trunc(options.pageNumber));
        const openNote = [...sortedAnnotationNoteWindows.value]
            .reverse()
            .find(note =>
                note.comment.source === 'editor'
                && note.comment.pageNumber === pageNumber,
            );
        if (!openNote) {
            return markerRect;
        }

        const previousComment = openNote.comment;
        openNote.comment = {
            ...previousComment,
            markerRect,
        };
        annotationComments.value = annotationComments.value.map(comment => (
            comment.stableKey === previousComment.stableKey
            || isSameAnnotationComment(comment, previousComment)
                ? {
                    ...comment,
                    markerRect,
                }
                : comment
        ));
        return markerRect;
    }

    function getAgentShapeCreateOptions(input: Record<string, unknown>) {
        const tool = getAgentStringInput(input, 'shape')
            ?? getAgentStringInput(input, 'tool')
            ?? getAgentStringInput(input, 'kind');
        if (!isAgentShapeTool(tool)) {
            throw new Error('annotation.create_shape requires input.shape: draw, rectangle, circle, line, or arrow.');
        }

        const points = getAgentPointArrayInput(input, 'points');
        const strokes = getAgentStrokeArrayInput(input, 'strokes');
        const firstPoint = points?.[0] ?? strokes?.[0]?.[0] ?? null;
        const x = getAgentNumberInput(input, 'x') ?? getAgentNumberInput(input, 'pageX') ?? firstPoint?.x ?? null;
        const y = getAgentNumberInput(input, 'y') ?? getAgentNumberInput(input, 'pageY') ?? firstPoint?.y ?? null;
        if (x === null || y === null) {
            throw new Error('annotation.create_shape requires normalized input.x and input.y coordinates.');
        }

        return {
            pageNumber: getAgentNumberInput(input, 'page')
                ?? getAgentNumberInput(input, 'pageNumber')
                ?? currentPage.value,
            tool,
            x,
            y,
            width: getAgentNumberInput(input, 'width') ?? undefined,
            height: getAgentNumberInput(input, 'height') ?? undefined,
            x2: getAgentNumberInput(input, 'x2') ?? getAgentNumberInput(input, 'endX') ?? undefined,
            y2: getAgentNumberInput(input, 'y2') ?? getAgentNumberInput(input, 'endY') ?? undefined,
            points,
            strokes,
            color: getAgentStringInput(input, 'color') ?? undefined,
            fillColor: getAgentNullableStringInput(input, 'fillColor'),
            opacity: getAgentNumberInput(input, 'opacity') ?? undefined,
            strokeWidth: getAgentNumberInput(input, 'strokeWidth') ?? undefined,
        };
    }

    function normalizeAgentAnnotationComment(comment: IAnnotationCommentSummary) {
        return {
            id: comment.id,
            stableKey: comment.stableKey,
            pageIndex: comment.pageIndex,
            pageNumber: comment.pageNumber,
            text: comment.text,
            displayText: comment.displayText ?? null,
            previewText: comment.previewText ?? null,
            kindLabel: comment.kindLabel ?? null,
            subtype: comment.subtype ?? null,
            author: comment.author,
            createdAt: comment.createdAt ?? null,
            modifiedAt: comment.modifiedAt,
            color: comment.color,
            fillColor: comment.fillColor ?? null,
            opacity: comment.opacity ?? null,
            strokeWidth: comment.strokeWidth ?? null,
            uid: comment.uid,
            annotationId: comment.annotationId,
            source: comment.source,
            hasNote: comment.hasNote === true,
            markerRect: normalizeMarkerRect(comment.markerRect),
        };
    }

    function findAgentAnnotationComment(input: Record<string, unknown> | undefined) {
        const stableKey = getAgentStringInput(input, 'stableKey');
        const annotationId = getAgentStringInput(input, 'annotationId');
        const id = getAgentStringInput(input, 'id');
        const comment = annotationComments.value.find(candidate => (
            (stableKey !== null && candidate.stableKey === stableKey)
            || (annotationId !== null && candidate.annotationId === annotationId)
            || (id !== null && candidate.id === id)
        ));
        if (!comment) {
            throw new Error('Annotation comment was not found. Use evb://document/{tabId}/annotations to get stable keys.');
        }
        return comment;
    }

    function parseAgentResourceUri(uri: string) {
        let parsed: URL;
        try {
            parsed = new URL(uri);
        } catch {
            throw new Error(`Invalid EVB resource URI: ${uri}`);
        }
        if (parsed.protocol !== 'evb:') {
            throw new Error(`Unsupported EVB resource URI protocol: ${parsed.protocol}`);
        }
        const parts = parsed.pathname
            .split('/')
            .filter(Boolean)
            .map(part => decodeURIComponent(part));
        return {
            host: parsed.hostname,
            parts,
        };
    }

    function createAgentResource(uri: string): Record<string, unknown> {
        const parsed = parseAgentResourceUri(uri);
        if (parsed.host !== 'document') {
            throw new Error(`Unsupported workspace resource host: ${parsed.host}`);
        }
        const [
            resourceTabId,
            resourceKind,
        ] = parsed.parts;
        if (resourceTabId && resourceTabId !== tabId) {
            throw new Error(`Resource tab ${resourceTabId} does not match workspace tab ${tabId}.`);
        }

        if (!resourceKind || resourceKind === 'status' || resourceKind === 'state') {
            return {
                uri,
                tabId,
                status: 'ready',
                currentPage: currentPage.value,
                totalPages: totalPages.value,
                canSave: canSave.value,
                isSaving: isAnySaving.value,
                hasPdf: hasPdf.value,
                workingCopyPath: workingCopyPath.value,
                originalPath: originalPath.value,
                annotationDirty: annotationDirty.value,
                annotationNoteWindowsCount: sortedAnnotationNoteWindows.value.length,
                annotationCommentsStatus: annotationCommentsStatus.value,
                annotationCommentsCount: annotationComments.value.length,
            };
        }

        if (resourceKind === 'annotations') {
            return {
                uri,
                tabId,
                status: annotationCommentsStatus.value,
                count: annotationComments.value.length,
                annotations: annotationComments.value.map(normalizeAgentAnnotationComment),
            };
        }

        if (resourceKind === 'notes') {
            const openNoteByStableKey = new Map(
                sortedAnnotationNoteWindows.value.map(note => [
                    note.comment.stableKey,
                    note,
                ] as const),
            );
            const notes = annotationComments.value
                .filter(comment => (
                    comment.hasNote === true
                    || comment.text.trim().length > 0
                    || openNoteByStableKey.has(comment.stableKey)
                ))
                .map((comment) => {
                    const openNote = openNoteByStableKey.get(comment.stableKey) ?? null;
                    const openNoteMarkerRect = normalizeMarkerRect(openNote?.comment.markerRect);
                    const normalizedComment = normalizeAgentAnnotationComment(comment);
                    return {
                        ...normalizedComment,
                        markerRect: openNoteMarkerRect ?? normalizedComment.markerRect,
                        text: openNote?.text ?? comment.text,
                        isOpen: openNote !== null,
                        isMinimized: openNote?.isMinimized ?? false,
                        saving: openNote?.saving ?? false,
                        error: openNote?.error ?? null,
                        saveMode: openNote?.saveMode ?? null,
                    };
                });
            return {
                uri,
                tabId,
                status: annotationCommentsStatus.value,
                count: notes.length,
                notes,
            };
        }

        if (resourceKind === 'toc' || resourceKind === 'bookmarks') {
            const snapshot = createAgentBookmarkSnapshot();
            return {
                uri,
                tabId,
                status: 'ready',
                count: snapshot.count,
                dirty: snapshot.dirty,
                toc: snapshot.bookmarks,
                bookmarks: snapshot.bookmarks,
            };
        }

        if (resourceKind === 'page-labels' || resourceKind === 'page-numbering') {
            return {
                uri,
                tabId,
                status: 'ready',
                ...createAgentPageLabelSnapshot(),
            };
        }

        throw new Error(`Unsupported workspace document resource: ${resourceKind}`);
    }

    function readAgentResource(uri: string): Promise<Record<string, unknown>> {
        return Promise.resolve(createAgentResource(uri));
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
