import type { IEditedTextMarkupVisualOptions } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/textMarkupDomRemovalTypes';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TMarkupSubtype,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { parseCssRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/parseCssRgbColor';
import { rgbToHex } from '@app/modules/pdf-viewer/engine/text-markup-color/rgbToHex';
import { toOpaqueHighlightDisplayColor } from '@app/modules/pdf-viewer/engine/text-markup-color/toOpaqueHighlightDisplayColor';
import { collectTextMarkupElementCandidates } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/collectTextMarkupElementCandidates';
import { parseMarkupSubtype } from '@contracts/annotations';

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

interface IReconcileTextMarkupVisualOverlaysOptions {
    comments: readonly IAnnotationCommentSummary[];
    pageNumber?: number | undefined;
    removeSameKeyOnLiveHighlight: boolean;
    removeStaleVisuals: boolean;
    requireColorEdited: boolean;
    resolveColor: (comment: IAnnotationCommentSummary) => string | null;
    resolveHighlightOpacity?: ((comment: IAnnotationCommentSummary) => number | null | undefined) | undefined;
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
    annotationElements: HTMLElement[],
    subtype: TMarkupSubtype,
    color: string,
) {
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

function pageMatchesOption(comment: IAnnotationCommentSummary, pageNumber: number | undefined) {
    return !Number.isFinite(pageNumber)
        || pageNumber! <= 0
        || Math.floor(comment.pageNumber) === Math.floor(pageNumber!);
}

export function reconcileTextMarkupVisualOverlays(
    container: HTMLElement,
    options: IReconcileTextMarkupVisualOverlaysOptions,
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

    options.comments.forEach((comment) => {
        if (
            (options.requireColorEdited && comment.colorEdited !== true)
            || !isTextMarkupSubtype(comment.subtype)
            || !normalizeMarkerRect(comment.markerRect)
            || !pageMatchesOption(comment, options.pageNumber)
        ) {
            return;
        }
        collectTextMarkupElementCandidates(container, comment).pageContexts.forEach((pageContext) => {
            pageContainers.add(pageContext.pageContainer);
            const pageComments = commentsByPage.get(pageContext.pageContainer) ?? [];
            pageComments.push(comment);
            commentsByPage.set(pageContext.pageContainer, pageComments);
        });
    });

    if (options.removeStaleVisuals && !Number.isFinite(options.pageNumber)) {
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
        if (options.removeStaleVisuals && existingRoot) {
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
            const subtype: TMarkupSubtype | null = parseMarkupSubtype(comment.subtype);
            const rect = normalizeMarkerRect(comment.markerRect);
            if (!color || !subtype || !rect) {
                return;
            }
            const candidates = collectTextMarkupElementCandidates(pageContainer, comment);
            suppressNativeTextMarkupAnnotationLayerVisuals(candidates.annotationElements, subtype, color);
            if (subtype === 'Highlight' && hasLiveHighlightEditorMatchingRect(pageContainer, rect)) {
                if (options.removeSameKeyOnLiveHighlight) {
                    const root = getEditedTextMarkupOverlayRoot(pageContainer);
                    if (root) {
                        removeEditedTextMarkupOverlayVisual(root, getEditedTextMarkupVisualKey(comment));
                        removeEditedTextMarkupOverlayRootIfEmpty(root);
                    }
                }
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
