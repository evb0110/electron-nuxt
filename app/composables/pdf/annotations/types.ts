import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';

export type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    IAnnotationSettings,
    IAnnotationEditorState,
    ILinkAnnotation,
    IShapeAnnotation,
    TAnnotationTool,
    TMarkupSubtype,
    TShapeType,
    TLineEndStyle,
} from '@app/types/annotations';

export type {
    IPdfjsEditor, IAnnotationContextMenuPayload, 
} from '@app/composables/pdf/pdfAnnotationUtils';

export interface INormalizedRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface IViewportRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IMarkerViewModel {
    annotation: IAnnotationCommentSummary;
    clustered: IAnnotationCommentSummary[];
    leftPercent: number;
    topPercent: number;
    isActive: boolean;
    preview: string;
    ariaLabel: string;
}

export interface ISpatialIndexEntry {
    annotation: IAnnotationCommentSummary;
    viewportRect: IViewportRect;
    pageNumber: number;
}

export interface IAnnotationStoreState {
    annotations: IAnnotationCommentSummary[];
    activeKey: string | null;
}

export interface IAnnotationNotePosition {
    x: number;
    y: number;
    width?: number;
    height?: number;
}

export interface IAnnotationNoteWindowState {
    comment: IAnnotationCommentSummary;
    text: string;
    lastSavedText: string;
    saving: boolean;
    error: string | null;
    order: number;
    saveMode: 'auto' | 'embedded';
    isMinimized: boolean;
}

export interface IPagePointTarget {
    pageContainer: HTMLElement;
    pageNumber: number;
    pageX: number;
    pageY: number;
}

export function isNoteEligible(
    subtype: string | null | undefined,
    hasNote?: boolean,
    source?: 'editor' | 'pdf',
    text?: string,
): boolean {
    if (hasNote === true) {
        return true;
    }

    const normalized = (subtype ?? '').trim().toLowerCase();
    if (
        normalized === 'text'
        || normalized === 'note-linked'
        || normalized === 'freetext'
        || normalized === 'typewriter'
        || normalized === 'note-inline'
        || normalized.includes('popup')
        || normalized.includes('note')
    ) {
        return true;
    }

    if (source === 'editor' && typeof text === 'string' && text.trim().length > 0) {
        return true;
    }

    return false;
}

export function isNoteEligibleComment(comment: IAnnotationCommentSummary | null | undefined): boolean {
    if (!comment) {
        return false;
    }
    return isNoteEligible(comment.subtype, comment.hasNote, comment.source, comment.text);
}

export function compareAnnotations(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
): number {
    if (left.pageIndex !== right.pageIndex) {
        return left.pageIndex - right.pageIndex;
    }

    const leftSort = typeof left.sortIndex === 'number' ? left.sortIndex : null;
    const rightSort = typeof right.sortIndex === 'number' ? right.sortIndex : null;
    if (leftSort !== null && rightSort !== null && leftSort !== rightSort) {
        return leftSort - rightSort;
    }
    if (leftSort !== null && rightSort === null) {
        return -1;
    }
    if (leftSort === null && rightSort !== null) {
        return 1;
    }

    const leftTime = left.modifiedAt ?? 0;
    const rightTime = right.modifiedAt ?? 0;
    if (leftTime !== rightTime) {
        return rightTime - leftTime;
    }

    return left.stableKey.localeCompare(right.stableKey);
}

export function isSelectionMarkupTool(tool: TAnnotationTool): boolean {
    return tool === 'highlight' || tool === 'underline' || tool === 'strikethrough';
}

export function isShapeTool(tool: TAnnotationTool): boolean {
    return tool === 'rectangle' || tool === 'circle' || tool === 'line' || tool === 'arrow';
}

export function shouldForceTextMarkup(tool: TAnnotationTool): boolean {
    return tool === 'underline' || tool === 'strikethrough';
}

export const TOOL_TO_MARKUP_SUBTYPE: Partial<Record<TAnnotationTool, TMarkupSubtype>> = {
    underline: 'Underline',
    strikethrough: 'StrikeOut',
};

export function markerRectCenterDistance(
    left: IAnnotationMarkerRect | null | undefined,
    right: IAnnotationMarkerRect | null | undefined,
): number {
    if (!left || !right) {
        return Number.POSITIVE_INFINITY;
    }
    if (left.width <= 0 || left.height <= 0 || right.width <= 0 || right.height <= 0) {
        return Number.POSITIVE_INFINITY;
    }
    const leftCx = left.left + left.width / 2;
    const leftCy = left.top + left.height / 2;
    const rightCx = right.left + right.width / 2;
    const rightCy = right.top + right.height / 2;
    return Math.hypot(leftCx - rightCx, leftCy - rightCy);
}
