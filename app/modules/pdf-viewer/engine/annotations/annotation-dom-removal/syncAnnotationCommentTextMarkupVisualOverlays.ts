import type {
    IEditedTextMarkupVisualOptions,
    ITextMarkupElementCandidate,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/textMarkupDomRemovalTypes';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import { markerRectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/markerRectIoU';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { markerRectCenterDistance } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/markerRectCenterDistance';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { parseCssRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/parseCssRgbColor';
import { rgbToHex } from '@app/modules/pdf-viewer/engine/text-markup-color/rgbToHex';
import { toOpaqueHighlightDisplayColor } from '@app/modules/pdf-viewer/engine/text-markup-color/toOpaqueHighlightDisplayColor';

const MIN_HIGHLIGHT_VISUAL_IOU = 0.2;

const MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE = 0.025;

const TEXT_MARKUP_AXIS_TOLERANCE = 0.018;

const MIN_TEXT_MARKUP_HORIZONTAL_OVERLAP_RATIO = 0.2;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const EDITED_TEXT_MARKUP_OVERLAY_SELECTOR = 'svg[data-evb-edited-text-markup-overlay="true"]';

const EDITED_TEXT_MARKUP_OVERLAY_CLASS = 'pdf-edited-text-markup-overlay';

const EDITED_TEXT_MARKUP_VISUAL_CLASS = 'pdf-edited-text-markup-overlay__visual';

const EDITED_TEXT_MARKUP_VISUAL_KEY_ATTR = 'data-evb-edited-text-markup-key';

const EDITED_TEXT_MARKUP_STROKE_WIDTHS: Record<Exclude<TMarkupSubtype, 'Highlight'>, string> = {
    Underline: 'calc(var(--total-scale-factor, 1) * 0.571px)',
    StrikeOut: 'calc(var(--total-scale-factor, 1) * 1px)',
    Squiggly: 'calc(var(--total-scale-factor, 1) * 1px)',
};

const DEFAULT_EDITED_HIGHLIGHT_OVERLAY_OPACITY = 0.35;



function getAnnotationId(element: HTMLElement) {
    return element.dataset.annotationId ?? element.getAttribute('data-annotation-id');
}

function collectMatchingAnnotationElements(container: HTMLElement, annotationId: string) {
    const normalizedTarget = normalizePdfJsAnnotationId(annotationId);
    if (!normalizedTarget) {
        return [];
    }

    return Array.from(container.querySelectorAll<HTMLElement>('[data-annotation-id]'))
        .filter((element) => normalizePdfJsAnnotationId(getAnnotationId(element)) === normalizedTarget);
}

function appendUniqueElement(elements: HTMLElement[], element: HTMLElement) {
    if (!elements.includes(element)) {
        elements.push(element);
    }
}

function findPageContainers(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    annotationElements: HTMLElement[],
) {
    const pageContainers = new Set<HTMLElement>();

    annotationElements.forEach((element) => {
        const pageContainer = element.closest<HTMLElement>('.page_container');
        if (pageContainer) {
            pageContainers.add(pageContainer);
        }
    });

    if (Number.isFinite(comment.pageNumber) && comment.pageNumber > 0) {
        const pageNumber = Math.floor(comment.pageNumber);
        const pageContainer = container.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        );
        if (pageContainer) {
            pageContainers.add(pageContainer);
        }
    }

    return [...pageContainers];
}

function isTextMarkupElement(element: HTMLElement) {
    const className = String(element.className).toLowerCase();
    return className.includes('highlight')
        || className.includes('underline')
        || className.includes('strikeout')
        || className.includes('squiggly');
}

function rectFromElement(
    pageContainer: HTMLElement,
    element: Element & { getBoundingClientRect: () => DOMRect; },
): IAnnotationMarkerRect | null {
    const pageRect = pageContainer.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    if (
        pageRect.width <= 0
        || pageRect.height <= 0
        || elementRect.width <= 0
        || elementRect.height <= 0
    ) {
        return null;
    }

    return normalizeMarkerRect({
        left: (elementRect.left - pageRect.left) / pageRect.width,
        top: (elementRect.top - pageRect.top) / pageRect.height,
        width: elementRect.width / pageRect.width,
        height: elementRect.height / pageRect.height,
    });
}

function intervalOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
    return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function rectHasTextMarkupAxisOverlap(
    candidateRect: IAnnotationMarkerRect,
    targetRect: IAnnotationMarkerRect,
) {
    const targetLeft = targetRect.left - TEXT_MARKUP_AXIS_TOLERANCE;
    const targetRight = targetRect.left + targetRect.width + TEXT_MARKUP_AXIS_TOLERANCE;
    const targetTop = targetRect.top - TEXT_MARKUP_AXIS_TOLERANCE;
    const targetBottom = targetRect.top + targetRect.height + TEXT_MARKUP_AXIS_TOLERANCE;
    const candidateCenterX = candidateRect.left + candidateRect.width / 2;
    const candidateCenterY = candidateRect.top + candidateRect.height / 2;
    if (
        candidateCenterX < targetLeft
        || candidateCenterX > targetRight
        || candidateCenterY < targetTop
        || candidateCenterY > targetBottom
    ) {
        return false;
    }

    const horizontalOverlap = intervalOverlap(
        candidateRect.left,
        candidateRect.left + candidateRect.width,
        targetLeft,
        targetRight,
    );
    return horizontalOverlap / Math.max(candidateRect.width, Number.EPSILON)
        >= MIN_TEXT_MARKUP_HORIZONTAL_OVERLAP_RATIO;
}

function normalizeTextMarkupSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase();
}

function toTextMarkupSubtype(subtype: string | null | undefined): TMarkupSubtype | null {
    const normalized = normalizeTextMarkupSubtype(subtype);
    if (normalized === 'highlight') {
        return 'Highlight';
    }
    if (normalized === 'underline') {
        return 'Underline';
    }
    if (normalized === 'squiggly') {
        return 'Squiggly';
    }
    if (normalized === 'strikeout') {
        return 'StrikeOut';
    }
    return null;
}

function getEditedTextMarkupVisualKey(comment: IAnnotationCommentSummary) {
    return normalizePdfJsAnnotationId(comment.annotationId ?? comment.uid ?? comment.id)
        ?? comment.stableKey
        ?? comment.id;
}

function formatOverlayNumber(value: number) {
    const normalized = Math.abs(value) < 0.000001 ? 0 : value;
    if (Number.isInteger(normalized)) {
        return String(normalized);
    }
    return normalized
        .toFixed(6)
        .replace(/0+$/u, '')
        .replace(/\.$/u, '');
}

function normalizeEditedHighlightOverlayOpacity(value: number | null | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_EDITED_HIGHLIGHT_OVERLAY_OPACITY;
    }
    return Math.min(1, Math.max(0, value));
}

function normalizeComparableColor(value: string | null | undefined) {
    const parsed = parseCssRgbColor(value);
    return parsed ? rgbToHex(parsed).toLowerCase() : (value?.trim().toLowerCase() ?? '');
}

function normalizeEditedHighlightOverlayColor(color: string, opacity: number) {
    const normalizedColor = normalizeComparableColor(color);
    const matchingRawSwatch = ANNOTATION_COLOR_SWATCHES.find((swatch) => (
        normalizeComparableColor(toOpaqueHighlightDisplayColor(swatch, opacity)) === normalizedColor
    ));
    return matchingRawSwatch ?? color;
}

/**
 * True when a live PDF.js highlight editor (`.highlightEditor`) already covers
 * `rect` (normalized page coords, ~1% tolerance). Used to avoid double-painting:
 * if the live editor is already drawing this highlight, the edited-colour overlay
 * must NOT also paint it, or the highlight renders doubled/widened.
 */
function hasLiveHighlightEditorMatchingRect(pageContainer: HTMLElement, rect: IAnnotationMarkerRect) {
    const editorLayer = pageContainer.querySelector<HTMLElement>('.annotationEditorLayer');
    if (!editorLayer) {
        return false;
    }
    const editorDivs = editorLayer.querySelectorAll<HTMLElement>(':scope > .highlightEditor');
    if (editorDivs.length === 0) {
        return false;
    }
    const layerRect = editorLayer.getBoundingClientRect();
    if (layerRect.width <= 0 || layerRect.height <= 0) {
        return false;
    }
    const tolerance = 0.01;
    for (const div of editorDivs) {
        const r = div.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) {
            continue;
        }
        const nLeft = (r.left - layerRect.left) / layerRect.width;
        const nTop = (r.top - layerRect.top) / layerRect.height;
        const nWidth = r.width / layerRect.width;
        const nHeight = r.height / layerRect.height;
        if (
            Math.abs(nLeft - rect.left) < tolerance
            && Math.abs(nTop - rect.top) < tolerance
            && Math.abs(nWidth - rect.width) < tolerance
            && Math.abs(nHeight - rect.height) < tolerance
        ) {
            return true;
        }
    }
    return false;
}

function createLineOverlayPath(rect: IAnnotationMarkerRect, yRatio: number) {
    const y = rect.top + rect.height * yRatio;
    return [
        `M ${formatOverlayNumber(rect.left)} ${formatOverlayNumber(y)}`,
        `L ${formatOverlayNumber(rect.left + rect.width)} ${formatOverlayNumber(y)}`,
    ].join(' ');
}

function createSquigglyOverlayPath(rect: IAnnotationMarkerRect) {
    const amplitude = Math.max(rect.height * 0.09, 0.001);
    const baseline = rect.top + rect.height * 0.84;
    const step = Math.max(rect.height * 0.16, rect.width / 28, 0.002);
    let x = rect.left;
    let up = true;
    const right = rect.left + rect.width;
    const commands = [`M ${formatOverlayNumber(x)} ${formatOverlayNumber(baseline - amplitude)}`];

    while (x < right) {
        x = Math.min(right, x + step);
        commands.push(`L ${formatOverlayNumber(x)} ${formatOverlayNumber(up ? baseline + amplitude : baseline - amplitude)}`);
        up = !up;
    }

    return commands.join(' ');
}

function createTextMarkupOverlayPath(subtype: TMarkupSubtype, rect: IAnnotationMarkerRect) {
    if (subtype === 'Underline') {
        return createLineOverlayPath(rect, 1);
    }
    if (subtype === 'StrikeOut') {
        return createLineOverlayPath(rect, 0.52);
    }
    if (subtype === 'Squiggly') {
        return createSquigglyOverlayPath(rect);
    }
    return null;
}

function getEditedTextMarkupOverlayHost(pageContainer: HTMLElement) {
    return pageContainer.querySelector<HTMLElement>('.page_canvas, .canvasWrapper') ?? pageContainer;
}

function getEditedTextMarkupOverlayRoot(pageContainer: HTMLElement) {
    const host = getEditedTextMarkupOverlayHost(pageContainer);
    return host.querySelector<SVGSVGElement>(EDITED_TEXT_MARKUP_OVERLAY_SELECTOR);
}

function ensureEditedTextMarkupOverlayRoot(pageContainer: HTMLElement) {
    const existing = getEditedTextMarkupOverlayRoot(pageContainer);
    if (existing) {
        return existing;
    }

    const host = getEditedTextMarkupOverlayHost(pageContainer);
    const root = pageContainer.ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
    host.style.setProperty('position', 'relative');
    root.setAttribute('class', EDITED_TEXT_MARKUP_OVERLAY_CLASS);
    root.setAttribute('data-evb-edited-text-markup-overlay', 'true');
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('focusable', 'false');
    root.setAttribute('viewBox', '0 0 1 1');
    root.setAttribute('preserveAspectRatio', 'none');
    root.style.setProperty('position', 'absolute');
    root.style.setProperty('inset', '0');
    root.style.setProperty('width', '100%');
    root.style.setProperty('height', '100%');
    root.style.setProperty('overflow', 'visible');
    root.style.setProperty('pointer-events', 'none');
    root.style.setProperty('z-index', '3');
    host.append(root);
    return root;
}

function removeEditedTextMarkupOverlayRootIfEmpty(root: SVGSVGElement) {
    if (root.querySelectorAll(`.${EDITED_TEXT_MARKUP_VISUAL_CLASS}`).length === 0) {
        root.remove();
    }
}

function removeEditedTextMarkupOverlayVisual(root: SVGSVGElement, key: string) {
    root
        .querySelectorAll<SVGGElement>(`.${EDITED_TEXT_MARKUP_VISUAL_CLASS}`)
        .forEach((visual) => {
            if (visual.getAttribute(EDITED_TEXT_MARKUP_VISUAL_KEY_ATTR) === key) {
                visual.remove();
            }
        });
}

function appendEditedTextMarkupOverlayVisual(
    root: SVGSVGElement,
    comment: IAnnotationCommentSummary,
    color: string,
    subtype: TMarkupSubtype,
    rect: IAnnotationMarkerRect,
    options: IEditedTextMarkupVisualOptions = {},
) {
    const key = getEditedTextMarkupVisualKey(comment);
    removeEditedTextMarkupOverlayVisual(root, key);

    const visual = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
    visual.setAttribute('class', `${EDITED_TEXT_MARKUP_VISUAL_CLASS} ${EDITED_TEXT_MARKUP_VISUAL_CLASS}--${subtype.toLowerCase()}`);
    visual.setAttribute(EDITED_TEXT_MARKUP_VISUAL_KEY_ATTR, key);
    if (comment.annotationId) {
        visual.setAttribute('data-annotation-id', comment.annotationId);
    }
    visual.style.setProperty('pointer-events', 'none');

    if (subtype === 'Highlight') {
        const highlightOpacity = normalizeEditedHighlightOverlayOpacity(options.highlightOpacity);
        const highlightColor = normalizeEditedHighlightOverlayColor(color, highlightOpacity);
        const highlightRect = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');
        highlightRect.setAttribute('x', formatOverlayNumber(rect.left));
        highlightRect.setAttribute('y', formatOverlayNumber(rect.top));
        highlightRect.setAttribute('width', formatOverlayNumber(rect.width));
        highlightRect.setAttribute('height', formatOverlayNumber(rect.height));
        highlightRect.setAttribute('fill', highlightColor);
        highlightRect.setAttribute('fill-opacity', formatOverlayNumber(highlightOpacity));
        highlightRect.style.setProperty('mix-blend-mode', 'multiply');
        visual.append(highlightRect);
    } else {
        const path = createTextMarkupOverlayPath(subtype, rect);
        if (!path) {
            return false;
        }
        const strokeWidth = EDITED_TEXT_MARKUP_STROKE_WIDTHS[subtype];
        const stroke = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'path');
        stroke.setAttribute('d', path);
        stroke.setAttribute('fill', 'none');
        stroke.setAttribute('stroke', color);
        stroke.setAttribute('stroke-opacity', '1');
        stroke.setAttribute('stroke-linecap', subtype === 'Squiggly' ? 'round' : 'butt');
        stroke.setAttribute('stroke-linejoin', subtype === 'Squiggly' ? 'round' : 'miter');
        stroke.setAttribute('stroke-width', strokeWidth);
        stroke.setAttribute('vector-effect', 'non-scaling-stroke');
        stroke.style.setProperty('stroke', color);
        stroke.style.setProperty('stroke-width', strokeWidth);
        visual.append(stroke);
    }

    root.append(visual);
    return true;
}

function suppressNativeTextMarkupDecorationElement(element: HTMLElement, color: string) {
    element.style.setProperty('--pdf-markup-subtype-color', color);
    element.dataset.markupSubtypeColor = 'true';
    element.style.textDecorationColor = color;
    element.style.borderBottomColor = color;
    element.style.borderTopColor = color;
    element.style.setProperty('text-decoration-line', 'none', 'important');
    element.style.setProperty('text-decoration', 'none', 'important');
    element.style.setProperty('border-bottom-style', 'none', 'important');
    element.style.setProperty('border-top-style', 'none', 'important');
}

function suppressNativeHighlightVisualElement(element: HTMLElement, color: string) {
    element.style.setProperty('--pdf-markup-subtype-color', color);
    element.dataset.markupSubtypeColor = 'true';
    element.style.setProperty('background', 'transparent', 'important');
    element.style.setProperty('background-color', 'transparent', 'important');
    element.style.setProperty('box-shadow', 'none', 'important');
}

function suppressNativeHighlightPaintElement(element: SVGElement) {
    element.style.setProperty('fill', 'transparent', 'important');
    element.style.setProperty('fill-opacity', '0', 'important');
    element.setAttribute('fill', 'transparent');
    element.setAttribute('fill-opacity', '0');
}

function suppressNativeTextMarkupAnnotationLayerVisuals(
    pageContainer: HTMLElement,
    comment: IAnnotationCommentSummary,
    subtype: TMarkupSubtype,
    color: string,
) {
    const annotationElements = comment.annotationId
        ? collectMatchingAnnotationElements(pageContainer, comment.annotationId)
        : [];
    collectGeometryMatchedTextMarkupElements(pageContainer, comment)
        .forEach(element => appendUniqueElement(annotationElements, element));
    if (subtype === 'Highlight') {
        annotationElements.forEach((element) => {
            suppressNativeHighlightVisualElement(element, color);
            element
                .querySelectorAll<HTMLElement>('.overlaidText, mark')
                .forEach(node => suppressNativeHighlightVisualElement(node, color));
            element
                .querySelectorAll<SVGElement>('svg, path, line, rect, polyline, polygon')
                .forEach(suppressNativeHighlightPaintElement);
        });
        return;
    }

    annotationElements.forEach((element) => {
        suppressNativeTextMarkupDecorationElement(element, color);
        element
            .querySelectorAll<HTMLElement>('.overlaidText, mark, u, s')
            .forEach(node => suppressNativeTextMarkupDecorationElement(node, color));
    });
}

function collectGeometryMatchedTextMarkupElements(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
): HTMLElement[] {
    const commentRect = normalizeMarkerRect(comment.markerRect);
    if (!commentRect) {
        return [];
    }

    const matchedCandidates: ITextMarkupElementCandidate[] = [];

    findPageContainers(container, comment, []).forEach((pageContainer) => {
        const candidates = Array.from(pageContainer.querySelectorAll<HTMLElement>('[data-annotation-id]'))
            .filter(isTextMarkupElement);
        candidates.forEach((element) => {
            const elementRect = rectFromElement(pageContainer, element);
            if (!elementRect) {
                return;
            }
            const iou = markerRectIoU(elementRect, commentRect);
            const distance = markerRectCenterDistance(elementRect, commentRect);
            const axisOverlap = rectHasTextMarkupAxisOverlap(elementRect, commentRect);
            const candidate = {
                axisOverlap,
                distance,
                element,
                iou,
            };
            if (
                candidate.iou >= MIN_HIGHLIGHT_VISUAL_IOU
                || candidate.distance <= MAX_HIGHLIGHT_VISUAL_CENTER_DISTANCE
                || candidate.axisOverlap
            ) {
                matchedCandidates.push(candidate);
            }
        });
    });

    return matchedCandidates
        .sort((left, right) => (
            right.iou - left.iou
            || Number(right.axisOverlap) - Number(left.axisOverlap)
            || left.distance - right.distance
        ))
        .map(candidate => candidate.element);
}

export function syncAnnotationCommentTextMarkupVisualOverlays(
    container: HTMLElement,
    comments: readonly IAnnotationCommentSummary[],
    options: {
        pageNumber?: number | undefined;
        resolveColor: (comment: IAnnotationCommentSummary) => string | null;
        resolveHighlightOpacity?: (comment: IAnnotationCommentSummary) => number | null | undefined;
    },
) {
    const commentsByPage = new Map<HTMLElement, IAnnotationCommentSummary[]>();
    const pageContainers = new Set<HTMLElement>();
    if (Number.isFinite(options.pageNumber) && options.pageNumber! > 0) {
        const pageContainer = container.querySelector<HTMLElement>(
            `.page_container[data-page="${Math.floor(options.pageNumber!)}"]`,
        );
        if (pageContainer) {
            pageContainers.add(pageContainer);
        }
    }

    comments.forEach((comment) => {
        if (!comment.colorEdited || !isTextMarkupSubtype(comment.subtype) || !normalizeMarkerRect(comment.markerRect)) {
            return;
        }
        findPageContainers(container, comment, []).forEach((pageContainer) => {
            if (
                Number.isFinite(options.pageNumber)
                && options.pageNumber! > 0
                && Math.floor(comment.pageNumber) !== Math.floor(options.pageNumber!)
            ) {
                return;
            }
            pageContainers.add(pageContainer);
            const pageComments = commentsByPage.get(pageContainer) ?? [];
            pageComments.push(comment);
            commentsByPage.set(pageContainer, pageComments);
        });
    });

    if (!Number.isFinite(options.pageNumber)) {
        container
            .querySelectorAll<SVGSVGElement>(EDITED_TEXT_MARKUP_OVERLAY_SELECTOR)
            .forEach((root) => {
                const pageContainer = root.closest<HTMLElement>('.page_container');
                if (pageContainer) {
                    pageContainers.add(pageContainer);
                }
            });
    }

    let updatedCount = 0;
    pageContainers.forEach((pageContainer) => {
        const pageComments = commentsByPage.get(pageContainer) ?? [];
        const currentKeys = new Set(pageComments.map(getEditedTextMarkupVisualKey));
        const existingRoot = getEditedTextMarkupOverlayRoot(pageContainer);
        if (existingRoot) {
            existingRoot
                .querySelectorAll<SVGGElement>(`.${EDITED_TEXT_MARKUP_VISUAL_CLASS}`)
                .forEach((visual) => {
                    const key = visual.getAttribute(EDITED_TEXT_MARKUP_VISUAL_KEY_ATTR);
                    if (!key || !currentKeys.has(key)) {
                        visual.remove();
                        updatedCount += 1;
                    }
                });
            removeEditedTextMarkupOverlayRootIfEmpty(existingRoot);
        }

        pageComments.forEach((comment) => {
            const color = options.resolveColor(comment)?.trim();
            const subtype = toTextMarkupSubtype(comment.subtype);
            const rect = normalizeMarkerRect(comment.markerRect);
            if (!color || !subtype || !rect) {
                return;
            }
            suppressNativeTextMarkupAnnotationLayerVisuals(pageContainer, comment, subtype, color);
            if (subtype === 'Highlight' && hasLiveHighlightEditorMatchingRect(pageContainer, rect)) {
                return;
            }
            const root = ensureEditedTextMarkupOverlayRoot(pageContainer);
            if (appendEditedTextMarkupOverlayVisual(
                root,
                comment,
                color,
                subtype,
                rect,
                { highlightOpacity: options.resolveHighlightOpacity?.(comment) },
            )) {
                updatedCount += 1;
            }
        });
    });

    return updatedCount;
}
