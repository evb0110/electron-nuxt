import type {
    IHighlightVisualCandidate,
    ITextMarkupColorReadResult,
    ITextMarkupCandidateContext,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/textMarkupDomRemovalTypes';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { parseCssRgbColor } from '@app/modules/pdf-viewer/engine/text-markup-color/parseCssRgbColor';
import { rgbToHex } from '@app/modules/pdf-viewer/engine/text-markup-color/rgbToHex';
import type { ITextMarkupColorResolutionDiagnostics } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/textMarkupColorResolutionDiagnostics';
import { collectTextMarkupElementCandidates } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/collectTextMarkupElementCandidates';
import { scoreTextMarkupVisualCandidate } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/scoreTextMarkupVisualCandidate';
import { sampleCanvasTextMarkupColorAtPoint } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/sampleCanvasTextMarkupColorAtPoint';
import { sampleCanvasTextMarkupColorInRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/sampleCanvasTextMarkupColorInRect';

export interface IResolveTextMarkupColorOptions {
    atPoint?: {
        pageX: number;
        pageY: number;
    };
    diagnostics?: ITextMarkupColorResolutionDiagnostics | undefined;
}

interface IScoredHighlightVisualCandidate extends IHighlightVisualCandidate {matched: boolean;}

function getDrawLayerTextMarkupSvgs(pageContainer: HTMLElement) {
    return Array.from(pageContainer.querySelectorAll<SVGElement>(
        [
            '.page_canvas svg.highlight:not(.free)',
            '.canvasWrapper svg.highlight:not(.free)',
            '.page_canvas svg.pdf-markup-subtype-draw-visual',
            '.canvasWrapper svg.pdf-markup-subtype-draw-visual',
            '.page_canvas svg[class*="pdf-markup-subtype-draw-visual"]',
            '.canvasWrapper svg[class*="pdf-markup-subtype-draw-visual"]',
            '.annotationLayer section svg',
            '.annotation-layer section svg',
        ].join(', '),
    )).filter(svg => !svg.classList.contains('pdf-highlight-composite-overlay'));
}

function toHighlightVisualCandidate(
    context: ITextMarkupCandidateContext,
    pageContainer: HTMLElement,
    svg: SVGElement,
    targetRects: IAnnotationMarkerRect[],
): IScoredHighlightVisualCandidate | null {
    const svgRect = context.getRectForElement(pageContainer, svg);
    if (!svgRect) {
        return null;
    }

    let best: IScoredHighlightVisualCandidate | null = null;
    targetRects.forEach((targetRect) => {
        const score = scoreTextMarkupVisualCandidate(svgRect, targetRect);
        const candidate: IScoredHighlightVisualCandidate = {
            axisOverlap: score.axisOverlap,
            distance: score.distance,
            iou: score.iou,
            matched: score.matched,
            svg,
        };
        if (
            !best
            || candidate.iou > best.iou
            || (
                candidate.iou === best.iou
                && Number(candidate.axisOverlap) > Number(best.axisOverlap)
            )
            || (
                candidate.iou === best.iou
                && candidate.axisOverlap === best.axisOverlap
                && candidate.distance < best.distance
            )
        ) {
            best = candidate;
        }
    });

    return best;
}

function collectMatchingHighlightVisuals(
    context: ITextMarkupCandidateContext,
    pageContainer: HTMLElement,
    targetRects: IAnnotationMarkerRect[],
) {
    const candidates: IScoredHighlightVisualCandidate[] = [];
    if (targetRects.length === 0) {
        return candidates;
    }

    for (const svg of getDrawLayerTextMarkupSvgs(pageContainer)) {
        const candidate = toHighlightVisualCandidate(context, pageContainer, svg, targetRects);
        if (!candidate || !candidate.matched) {
            continue;
        }
        candidates.push(candidate);
    }
    return candidates.sort((left, right) => (
        right.iou - left.iou
        || Number(right.axisOverlap) - Number(left.axisOverlap)
        || left.distance - right.distance
    ));
}

function isFullyTransparentColor(value: string) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || trimmed === 'transparent' || trimmed === 'none') {
        return true;
    }
    if (/\/\s*0(?:\.0+)?%?\s*\)?$/.test(trimmed)) {
        return true;
    }
    const match = /^rgba?\((?<channels>.+)\)$/i.exec(trimmed);
    const alpha = match?.groups?.channels
        ?.match(/-?\d*\.?\d+%?/g)
        ?.at(3);
    if (!alpha) {
        return false;
    }
    const normalizedAlpha = alpha.endsWith('%')
        ? Number.parseFloat(alpha.slice(0, -1)) / 100
        : Number.parseFloat(alpha);
    return Number.isFinite(normalizedAlpha) && normalizedAlpha <= 0;
}

function normalizeVisibleCssColor(value: string | null | undefined) {
    const trimmed = value?.trim() ?? '';
    if (isFullyTransparentColor(trimmed) || trimmed === 'currentcolor') {
        return null;
    }
    const parsed = parseCssRgbColor(trimmed);
    return parsed ? rgbToHex(parsed) : null;
}

function firstVisibleCssColor(values: Array<string | null | undefined>) {
    for (const value of values) {
        const color = normalizeVisibleCssColor(value);
        if (color) {
            return color;
        }
    }
    return null;
}

function readComputedStyle(element: Element) {
    try {
        return typeof getComputedStyle === 'function'
            ? getComputedStyle(element)
            : null;
    } catch {
        return null;
    }
}

function isElementHiddenForColorRead(element: Element) {
    let current: Element | null = element;
    while (current) {
        const style = readComputedStyle(current);
        const opacity = style?.opacity ? Number.parseFloat(style.opacity) : Number.NaN;
        if (
            style?.display === 'none'
            || style?.visibility === 'hidden'
            || style?.visibility === 'collapse'
            || (Number.isFinite(opacity) && opacity <= 0.01)
        ) {
            return true;
        }
        current = current.parentElement;
    }
    return false;
}

function describeColorElement(element: Element) {
    const tagName = typeof element.tagName === 'string'
        ? element.tagName.toLowerCase()
        : 'element';
    const className = typeof element.className === 'string'
        ? element.className
        : '';
    const id = element.id ? `#${element.id}` : '';
    const classes = className
        ? `.${className.trim().split(/\s+/).slice(0, 3).join('.')}`
        : '';
    const annotationId = typeof HTMLElement !== 'undefined' && element instanceof HTMLElement
        ? (element.dataset.annotationId ?? element.getAttribute('data-annotation-id') ?? '')
        : '';
    const annotation = annotationId ? `[data-annotation-id="${annotationId}"]` : '';
    return `${tagName}${id}${classes}${annotation}`;
}

function getElementClassName(element: Element | null | undefined) {
    if (!element) {
        return '';
    }
    const classAttribute = element.getAttribute('class');
    if (classAttribute) {
        return classAttribute;
    }
    const className = (element as { className?: unknown }).className;
    if (typeof className === 'string') {
        return className;
    }
    return '';
}

function elementHasClassFragment(element: Element | null | undefined, fragment: string) {
    return getElementClassName(element).split(/\s+/).some(className => className.includes(fragment));
}

function isSubtypeDrawVisualElement(element: Element | null | undefined) {
    return elementHasClassFragment(element, 'pdf-markup-subtype-draw-visual')
        || elementHasClassFragment(element, 'pdf-markup-subtype-draw-underline')
        || elementHasClassFragment(element, 'pdf-markup-subtype-draw-strikeout')
        || elementHasClassFragment(element, 'pdf-markup-subtype-draw-squiggly');
}

function isSubtypeDrawStrokeVisualElement(element: Element | null | undefined) {
    return elementHasClassFragment(element, 'pdf-markup-subtype-draw-visual');
}

function isSvgPaintElement(element: Element | null | undefined) {
    const tagName = element?.tagName?.toLowerCase() ?? '';
    return tagName === 'svg'
        || tagName === 'path'
        || tagName === 'rect'
        || tagName === 'line'
        || tagName === 'polyline'
        || tagName === 'polygon'
        || tagName === 'use';
}

function shouldReadNonHighlightCustomColor(element: Element) {
    return isSubtypeDrawStrokeVisualElement(element)
        || elementHasClassFragment(element, 'pdf-markup-subtype-underline')
        || elementHasClassFragment(element, 'pdf-markup-subtype-strikeout')
        || elementHasClassFragment(element, 'pdf-markup-subtype-squiggly')
        || Boolean((element as HTMLElement).dataset?.markupSubtypeColor);
}

function readElementTextMarkupColorResult(
    element: Element,
    subtype: string,
): ITextMarkupColorReadResult | null {
    if (isElementHiddenForColorRead(element)) {
        return null;
    }
    const style = readComputedStyle(element);
    const hasTextDecorationColor = subtype !== 'highlight'
        && style?.textDecorationLine !== undefined
        && style.textDecorationLine !== 'none'
        && style.textDecorationLine.trim().length > 0;
    const hasBottomBorderColor = subtype !== 'highlight'
        && style?.borderBottomStyle !== undefined
        && style.borderBottomStyle !== 'none'
        && style.borderBottomWidth !== '0px';
    const hasTopBorderColor = subtype !== 'highlight'
        && style?.borderTopStyle !== undefined
        && style.borderTopStyle !== 'none'
        && style.borderTopWidth !== '0px';
    const ownColor = firstVisibleCssColor([
        subtype === 'highlight'
            ? (element as HTMLElement).style?.getPropertyValue('--pdf-markup-subtype-color')
            : null,
        subtype === 'highlight' ? style?.getPropertyValue('--pdf-markup-subtype-color') : null,
        subtype !== 'highlight' && shouldReadNonHighlightCustomColor(element)
            ? (element as HTMLElement).style?.getPropertyValue('--pdf-markup-subtype-color')
            : null,
        subtype !== 'highlight' && shouldReadNonHighlightCustomColor(element)
            ? style?.getPropertyValue('--pdf-markup-subtype-color')
            : null,
        subtype === 'highlight' ? style?.backgroundColor : null,
        subtype === 'highlight' && isSvgPaintElement(element) ? style?.fill : null,
        subtype === 'highlight' && isSvgPaintElement(element) ? element.getAttribute('fill') : null,
        hasTextDecorationColor ? style?.textDecorationColor : null,
        hasBottomBorderColor ? style?.borderBottomColor : null,
        hasTopBorderColor ? style?.borderTopColor : null,
        subtype === 'highlight' ? null : style?.stroke,
        subtype === 'highlight' ? null : element.getAttribute('stroke'),
    ]);
    if (ownColor) {
        return {
            color: ownColor,
            element: describeColorElement(element),
            source: 'element',
        };
    }

    const visualNodes = element.querySelectorAll<SVGElement>('svg, path, rect, line, polyline, polygon, use, mark, u, s');
    for (const node of visualNodes) {
        if (isElementHiddenForColorRead(node)) {
            continue;
        }
        const nodeStyle = readComputedStyle(node);
        const hasNodeTextDecorationColor = subtype !== 'highlight'
            && nodeStyle?.textDecorationLine !== undefined
            && nodeStyle.textDecorationLine !== 'none'
            && nodeStyle.textDecorationLine.trim().length > 0;
        const allowNonHighlightCustomColor = subtype !== 'highlight'
            && shouldReadNonHighlightCustomColor(node);
        const nodeColor = firstVisibleCssColor([
            subtype === 'highlight' ? node.style.getPropertyValue('--pdf-markup-subtype-color') : null,
            subtype === 'highlight' ? nodeStyle?.getPropertyValue('--pdf-markup-subtype-color') : null,
            subtype === 'highlight' ? null : nodeStyle?.stroke,
            subtype === 'highlight' ? null : node.getAttribute('stroke'),
            allowNonHighlightCustomColor ? node.style.getPropertyValue('--pdf-markup-subtype-color') : null,
            allowNonHighlightCustomColor ? nodeStyle?.getPropertyValue('--pdf-markup-subtype-color') : null,
            subtype === 'highlight' ? nodeStyle?.fill : null,
            subtype === 'highlight' ? node.getAttribute('fill') : null,
            subtype === 'highlight' ? nodeStyle?.backgroundColor : null,
            hasNodeTextDecorationColor ? nodeStyle?.textDecorationColor : null,
        ]);
        if (nodeColor) {
            return {
                color: nodeColor,
                element: describeColorElement(node),
                source: 'visual-node',
            };
        }
    }
    return null;
}

function appendUniqueElementLike(elements: Element[], element: Element | null | undefined) {
    if (element && !elements.includes(element)) {
        elements.push(element);
    }
}

function collectTextMarkupElementsFromPoint(
    container: HTMLElement,
    clientX: number,
    clientY: number,
) {
    const doc = container.ownerDocument;
    const elementsFromPoint = typeof doc.elementsFromPoint === 'function'
        ? doc.elementsFromPoint(clientX, clientY)
        : [];
    const candidates: Element[] = [];
    elementsFromPoint.forEach((element) => {
        if (!container.contains(element)) {
            return;
        }
        appendUniqueElementLike(candidates, element);
        appendUniqueElementLike(candidates, element.closest('[data-annotation-id]'));
        appendUniqueElementLike(candidates, element.closest('svg.highlight'));
        appendUniqueElementLike(candidates, element.closest('[class*="pdf-markup-subtype"]'));
        let parent = element.parentElement;
        while (parent && parent !== container) {
            if (
                parent.matches('[data-annotation-id]')
                || parent.matches('svg.highlight')
                || parent.matches('[class*="pdf-markup-subtype"]')
            ) {
                appendUniqueElementLike(candidates, parent);
            }
            parent = parent.parentElement;
        }
    });
    return candidates;
}

function pointDistanceToRect(clientX: number, clientY: number, rect: DOMRect) {
    const dx = clientX < rect.left
        ? rect.left - clientX
        : clientX > rect.right
            ? clientX - rect.right
            : 0;
    const dy = clientY < rect.top
        ? rect.top - clientY
        : clientY > rect.bottom
            ? clientY - rect.bottom
            : 0;
    return Math.hypot(dx, dy);
}

function getTextMarkupLineCandidateScore(
    element: Element,
    clientX: number,
    clientY: number,
) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height < 0) {
        return null;
    }
    const tolerance = Math.max(4, Math.min(10, rect.height + 4));
    const distance = pointDistanceToRect(clientX, clientY, rect);
    if (distance > tolerance) {
        return null;
    }
    const priority = isSubtypeDrawVisualElement(element)
        ? 0
        : getElementClassName(element).includes('highlight')
            ? 2
            : 1;
    return (priority * 1_000_000)
        + (distance * 1_000)
        + Math.min(rect.width * Math.max(rect.height, 1), 100_000);
}

function resolvePageContainerAtPoint(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
) {
    return collectTextMarkupElementCandidates(container, comment).pageContexts
        .map(pageContext => pageContext.pageContainer)
        .find((pageContainer) => {
            const rect = pageContainer.getBoundingClientRect();
            return clientX >= rect.left
                && clientX <= rect.right
                && clientY >= rect.top
                && clientY <= rect.bottom;
        })
        ?? container.ownerDocument.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('.page_container')
        ?? null;
}

function collectTextMarkupLineColorElementsNearPoint(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    subtype: string,
    clientX: number,
    clientY: number,
) {
    if (subtype === 'highlight') {
        return [];
    }
    const pageContainer = resolvePageContainerAtPoint(container, comment, clientX, clientY);
    if (!pageContainer || !container.contains(pageContainer)) {
        return [];
    }
    const selector = [
        '[class*="pdf-markup-subtype-draw"]',
        '[class*="pdf-markup-subtype-draw"] *',
        '.annotationEditorLayer [data-markup-subtype-color]',
        '.annotation-editor-layer [data-markup-subtype-color]',
        '.annotationLayer section svg',
        '.annotationLayer section svg *',
        '.annotation-layer section svg',
        '.annotation-layer section svg *',
        'svg.highlight:not(.free)',
        'svg.highlight:not(.free) *',
    ].join(', ');
    const candidates: Array<{
        element: Element;
        score: number;
    }> = [];
    pageContainer.querySelectorAll(selector).forEach((element) => {
        if (isElementHiddenForColorRead(element)) {
            return;
        }
        const score = getTextMarkupLineCandidateScore(element, clientX, clientY);
        if (score === null) {
            return;
        }
        candidates.push({
            element,
            score,
        });
    });
    return candidates
        .sort((left, right) => left.score - right.score)
        .map(candidate => candidate.element);
}

function readCanvasTextMarkupColorAtPoint(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
) {
    const pageContainer = resolvePageContainerAtPoint(container, comment, clientX, clientY);
    if (!pageContainer || !container.contains(pageContainer)) {
        return null;
    }
    for (const canvas of pageContainer.querySelectorAll<HTMLCanvasElement>('canvas')) {
        const color = sampleCanvasTextMarkupColorAtPoint(canvas, clientX, clientY);
        if (color) {
            return color;
        }
    }
    return null;
}

function readCanvasTextMarkupColorAtPointResult(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
): ITextMarkupColorResolutionDiagnostics | null {
    const color = readCanvasTextMarkupColorAtPoint(container, comment, clientX, clientY);
    return color
        ? {
            annotationId: comment.annotationId ?? null,
            color,
            element: 'canvas',
            pageNumber: comment.pageNumber ?? null,
            source: 'canvas',
            subtype: normalizeTextMarkupSubtype(comment.subtype),
        }
        : null;
}

function readCanvasTextMarkupColorForCommentResult(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
): ITextMarkupColorResolutionDiagnostics | null {
    const candidates = collectTextMarkupElementCandidates(container, comment);
    const subtype = normalizeTextMarkupSubtype(comment.subtype);
    for (const pageContext of candidates.pageContexts) {
        for (const canvas of pageContext.pageContainer.querySelectorAll<HTMLCanvasElement>('canvas')) {
            for (const targetRect of pageContext.targetRects) {
                const color = sampleCanvasTextMarkupColorInRect(canvas, pageContext.pageContainer, targetRect);
                if (color) {
                    return {
                        annotationId: comment.annotationId ?? null,
                        color,
                        element: 'canvas',
                        pageNumber: comment.pageNumber ?? null,
                        source: 'canvas',
                        subtype,
                    };
                }
            }
        }
    }
    return null;
}

function resolveAnnotationCommentTextMarkupColorWithDiagnostics(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
): ITextMarkupColorResolutionDiagnostics {
    if (!isTextMarkupSubtype(comment.subtype)) {
        return {
            annotationId: comment.annotationId ?? null,
            color: null,
            element: null,
            pageNumber: comment.pageNumber ?? null,
            source: 'not-text-markup',
            subtype: comment.subtype ?? null,
        };
    }
    const candidates = collectTextMarkupElementCandidates(container, comment);
    const subtype = normalizeTextMarkupSubtype(comment.subtype);

    for (const element of candidates.annotationElements) {
        const result = readElementTextMarkupColorResult(element, subtype);
        if (result) {
            return {
                annotationId: comment.annotationId ?? null,
                color: result.color,
                element: result.element,
                pageNumber: comment.pageNumber ?? null,
                source: result.source === 'element' ? 'summary:element' : 'summary:visual-node',
                subtype,
            };
        }
    }

    for (const pageContext of candidates.pageContexts) {
        for (const candidate of collectMatchingHighlightVisuals(
            candidates,
            pageContext.pageContainer,
            pageContext.targetRects,
        )) {
            const result = readElementTextMarkupColorResult(candidate.svg, subtype);
            if (result) {
                return {
                    annotationId: comment.annotationId ?? null,
                    color: result.color,
                    element: result.element,
                    pageNumber: comment.pageNumber ?? null,
                    source: result.source === 'element' ? 'visual:element' : 'visual:visual-node',
                    subtype,
                };
            }
        }
    }

    return {
        annotationId: comment.annotationId ?? null,
        color: null,
        element: null,
        pageNumber: comment.pageNumber ?? null,
        source: 'fallback:none',
        subtype,
    };
}

function normalizeTextMarkupSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase();
}

function resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    clientX: number,
    clientY: number,
): ITextMarkupColorResolutionDiagnostics {
    if (!isTextMarkupSubtype(comment.subtype)) {
        return {
            annotationId: comment.annotationId ?? null,
            color: null,
            element: null,
            pageNumber: comment.pageNumber ?? null,
            source: 'not-text-markup',
            subtype: comment.subtype ?? null,
        };
    }
    const subtype = normalizeTextMarkupSubtype(comment.subtype);
    const pointElements = collectTextMarkupElementsFromPoint(container, clientX, clientY);
    if (subtype === 'highlight') {
        const geometryCanvasResult = readCanvasTextMarkupColorForCommentResult(container, comment);
        if (geometryCanvasResult) {
            return {
                ...geometryCanvasResult,
                pointElementCount: pointElements.length,
            };
        }
    }
    if (subtype !== 'highlight') {
        for (const element of collectTextMarkupLineColorElementsNearPoint(
            container,
            comment,
            subtype,
            clientX,
            clientY,
        )) {
            const result = readElementTextMarkupColorResult(element, subtype);
            if (result) {
                return {
                    annotationId: comment.annotationId ?? null,
                    color: result.color,
                    element: result.element,
                    pageNumber: comment.pageNumber ?? null,
                    pointElementCount: pointElements.length,
                    source: result.source === 'element' ? 'point:nearby-element' : 'point:nearby-visual-node',
                    subtype,
                };
            }
        }
        const geometryCanvasResult = readCanvasTextMarkupColorForCommentResult(container, comment);
        if (geometryCanvasResult) {
            return {
                ...geometryCanvasResult,
                pointElementCount: pointElements.length,
            };
        }
    }
    for (const element of pointElements) {
        const result = readElementTextMarkupColorResult(element, subtype);
        if (result) {
            return {
                annotationId: comment.annotationId ?? null,
                color: result.color,
                element: result.element,
                pageNumber: comment.pageNumber ?? null,
                pointElementCount: pointElements.length,
                source: result.source === 'element' ? 'point:element' : 'point:visual-node',
                subtype,
            };
        }
    }
    const canvasResult = readCanvasTextMarkupColorAtPointResult(container, comment, clientX, clientY);
    if (canvasResult) {
        return {
            ...canvasResult,
            pointElementCount: pointElements.length,
        };
    }
    const fallback = resolveAnnotationCommentTextMarkupColorWithDiagnostics(container, comment);
    return {
        ...fallback,
        fallbackSource: fallback.source,
        pointElementCount: pointElements.length,
    };
}

function applyDiagnosticsSink(
    result: ITextMarkupColorResolutionDiagnostics,
    sink: ITextMarkupColorResolutionDiagnostics | undefined,
) {
    if (sink) {
        Object.assign(sink, result);
    }
    return result;
}

export function resolveAnnotationCommentTextMarkupColor(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
): string | null;
export function resolveAnnotationCommentTextMarkupColor(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    options: IResolveTextMarkupColorOptions & { atPoint: {
        pageX: number;
        pageY: number; 
    }; },
): ITextMarkupColorResolutionDiagnostics;
export function resolveAnnotationCommentTextMarkupColor(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    options?: IResolveTextMarkupColorOptions,
) {
    if (options?.atPoint) {
        return applyDiagnosticsSink(
            resolveAnnotationCommentTextMarkupColorAtPointWithDiagnostics(
                container,
                comment,
                options.atPoint.pageX,
                options.atPoint.pageY,
            ),
            options.diagnostics,
        );
    }
    return resolveAnnotationCommentTextMarkupColorWithDiagnostics(container, comment).color;
}
