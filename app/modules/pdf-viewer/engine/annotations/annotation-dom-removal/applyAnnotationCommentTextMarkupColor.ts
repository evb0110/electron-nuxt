import type {
    IHighlightVisualCandidate,
    ITextMarkupCandidateContext,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/textMarkupDomRemovalTypes';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { refreshHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { BrowserLogger } from '@app/utils/browserLogger';
import { recolorCanvasTextMarkupPixelsInRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-text-markup-canvas-pixels/recolorCanvasTextMarkupPixelsInRect';
import { collectTextMarkupElementCandidates } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/collectTextMarkupElementCandidates';
import { scoreTextMarkupVisualCandidate } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/scoreTextMarkupVisualCandidate';

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

function readComputedStyle(element: Element) {
    try {
        return typeof getComputedStyle === 'function'
            ? getComputedStyle(element)
            : null;
    } catch {
        return null;
    }
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

function isVisiblePaint(value: string | null | undefined) {
    return Boolean(value && value !== 'none' && value !== 'transparent');
}

function suppressSvgFill(svg: SVGElement) {
    let changed = isVisiblePaint(svg.getAttribute('fill'))
        || isVisiblePaint(svg.style.getPropertyValue('fill'));
    svg.setAttribute('fill', 'transparent');
    svg.setAttribute('fill-opacity', '0');
    svg.style.setProperty('fill', 'transparent');
    svg.style.setProperty('fill-opacity', '0');
    svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon, use').forEach((node) => {
        if (node.getAttribute('fill') === 'none') {
            return;
        }
        changed = changed
            || isVisiblePaint(node.getAttribute('fill'))
            || isVisiblePaint(node.style.getPropertyValue('fill'));
        node.setAttribute('fill', 'transparent');
        node.setAttribute('fill-opacity', '0');
        node.style.setProperty('fill', 'transparent');
        node.style.setProperty('fill-opacity', '0');
    });
    return changed;
}

function suppressSvgStroke(svg: SVGElement) {
    let changed = isVisiblePaint(svg.getAttribute('stroke'))
        || isVisiblePaint(svg.style.getPropertyValue('stroke'));
    svg.setAttribute('stroke', 'transparent');
    svg.setAttribute('stroke-opacity', '0');
    svg.style.setProperty('stroke', 'transparent');
    svg.style.setProperty('stroke-opacity', '0');
    svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon, use').forEach((node) => {
        const stroke = node.getAttribute('stroke');
        if (!stroke || stroke === 'none') {
            return;
        }
        changed = changed
            || isVisiblePaint(stroke)
            || isVisiblePaint(node.style.getPropertyValue('stroke'));
        node.setAttribute('stroke', 'transparent');
        node.setAttribute('stroke-opacity', '0');
        node.style.setProperty('stroke', 'transparent');
        node.style.setProperty('stroke-opacity', '0');
    });
    return changed;
}

function isTextMarkupStrokeNode(node: SVGElement, stroke: string | null | undefined) {
    const tagName = node.tagName.toLowerCase();
    return isVisiblePaint(stroke)
        && (
            tagName === 'line'
            || tagName === 'path'
            || tagName === 'polyline'
        );
}

function hasVisibleSvgFill(svg: SVGElement) {
    if (
        isVisiblePaint(svg.getAttribute('fill'))
        || isVisiblePaint(svg.style.getPropertyValue('fill'))
    ) {
        return true;
    }
    return Array.from(svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon, use'))
        .some(node => isVisiblePaint(node.getAttribute('fill'))
            || isVisiblePaint(node.style.getPropertyValue('fill')));
}

function shouldSuppressBaseSubtypeVisual(svg: SVGElement, subtype: string) {
    return subtype !== 'highlight'
        && !isSubtypeDrawStrokeVisualElement(svg)
        && (
            isSubtypeDrawVisualElement(svg)
            || (elementHasClassFragment(svg, 'highlight') && hasVisibleSvgFill(svg))
        );
}

function setSvgPaintColor(svg: SVGElement, color: string, subtype: string) {
    let updated = false;
    if (subtype === 'highlight') {
        svg.setAttribute('fill', color);
        svg.style.setProperty('fill', color);
        updated = true;
    } else {
        if (shouldSuppressBaseSubtypeVisual(svg, subtype)) {
            updated = suppressSvgFill(svg) || updated;
            updated = suppressSvgStroke(svg) || updated;
            svg.style.setProperty('color', color);
            svg.style.setProperty('--pdf-markup-subtype-color', color);
            return updated;
        }
        const rootFill = svg.getAttribute('fill');
        const rootStroke = svg.getAttribute('stroke');
        updated = suppressSvgFill(svg);
        if (!isVisiblePaint(rootFill) && isVisiblePaint(rootStroke)) {
            svg.setAttribute('stroke', color);
            svg.style.setProperty('stroke', color);
            updated = true;
        }
    }
    svg.style.setProperty('color', color);
    svg.style.setProperty('--pdf-markup-subtype-color', color);
    svg.querySelectorAll<SVGElement>('path, rect, line, polyline, polygon, use').forEach((node) => {
        node.style.setProperty('color', color);
        node.style.setProperty('--pdf-markup-subtype-color', color);
        const fill = node.getAttribute('fill');
        const stroke = node.getAttribute('stroke');
        if (subtype !== 'highlight' && !isTextMarkupStrokeNode(node, stroke)) {
            if (fill !== 'none') {
                node.setAttribute('fill', 'transparent');
                node.setAttribute('fill-opacity', '0');
                node.style.setProperty('fill', 'transparent');
                node.style.setProperty('fill-opacity', '0');
            }
            return;
        }
        if (subtype === 'highlight' && (!fill || fill !== 'none')) {
            node.setAttribute('fill', color);
            node.style.setProperty('fill', color);
            updated = true;
        }
        if (subtype !== 'highlight' || (stroke && stroke !== 'none')) {
            node.setAttribute('stroke', color);
            node.style.setProperty('stroke', color);
            updated = true;
        }
    });
    return updated;
}

function recolorMatchingHighlightVisuals(
    context: ITextMarkupCandidateContext,
    pageContainer: HTMLElement,
    targetRects: IAnnotationMarkerRect[],
    color: string,
    subtype: string,
) {
    const candidates = collectMatchingHighlightVisuals(context, pageContainer, targetRects);
    if (candidates.length === 0) {
        return 0;
    }

    const updatedCount = candidates
        .filter(candidate => setSvgPaintColor(candidate.svg, color, subtype))
        .length;
    if (updatedCount > 0) {
        refreshHighlightCompositeOverlay(pageContainer);
    }
    return updatedCount;
}

function normalizeTextMarkupSubtype(subtype: string | null | undefined) {
    return (subtype ?? '').trim().toLowerCase();
}

function applyAnnotationLayerTextMarkupColor(
    element: HTMLElement,
    subtype: string,
    color: string,
    opts: {
        forceVisible: boolean;
        suppressNativeTextMarkupDecoration: boolean;
    },
) {
    const computedStyle = readComputedStyle(element);
    const forceVisible = opts.forceVisible && subtype === 'highlight';
    const hasElementDecoration = subtype !== 'highlight' && (
        (
            computedStyle?.textDecorationLine !== undefined
            && computedStyle.textDecorationLine !== 'none'
            && computedStyle.textDecorationLine.trim().length > 0
        )
        || (
            computedStyle?.borderBottomStyle !== undefined
            && computedStyle.borderBottomStyle !== 'none'
            && computedStyle.borderBottomWidth !== '0px'
        )
        || (
            computedStyle?.borderTopStyle !== undefined
            && computedStyle.borderTopStyle !== 'none'
            && computedStyle.borderTopWidth !== '0px'
        )
    );
    element.style.setProperty('--pdf-markup-subtype-color', color);
    element.dataset.markupSubtypeColor = 'true';
    if (subtype === 'highlight') {
        if (forceVisible) {
            element.style.setProperty('background-color', color);
        } else {
            element.style.removeProperty('background');
            element.style.removeProperty('background-color');
        }
    } else {
        if (opts.suppressNativeTextMarkupDecoration) {
            element.style.setProperty('text-decoration-line', 'none');
            element.style.setProperty('text-decoration', 'none');
            element.style.setProperty('border-bottom-style', 'none');
            element.style.setProperty('border-top-style', 'none');
        }
        if (hasElementDecoration) {
            element.style.textDecorationColor = color;
            if (
                computedStyle?.borderBottomStyle !== undefined
                && computedStyle.borderBottomStyle !== 'none'
                && computedStyle.borderBottomWidth !== '0px'
            ) {
                element.style.borderBottomColor = color;
            }
            if (
                computedStyle?.borderTopStyle !== undefined
                && computedStyle.borderTopStyle !== 'none'
                && computedStyle.borderTopWidth !== '0px'
            ) {
                element.style.borderTopColor = color;
            }
        }
    }
    if (forceVisible) {
        element.style.setProperty('visibility', 'visible', 'important');
        element.style.setProperty('opacity', '1', 'important');
    }
    const textNodes = Array.from(element.querySelectorAll<HTMLElement>('.overlaidText, mark, u, s'));
    textNodes.forEach((node) => {
        node.dataset.markupSubtypeColor = 'true';
        node.style.textDecorationColor = color;
        if (subtype !== 'highlight' && opts.suppressNativeTextMarkupDecoration) {
            node.style.setProperty('text-decoration-line', 'none');
            node.style.setProperty('text-decoration', 'none');
            node.style.setProperty('border-bottom-style', 'none');
            node.style.setProperty('border-top-style', 'none');
        }
        if (forceVisible) {
            node.style.setProperty('visibility', 'visible', 'important');
            node.style.setProperty('opacity', '1', 'important');
        }
        if (subtype === 'highlight') {
            if (forceVisible) {
                node.style.setProperty('background-color', color);
            } else {
                node.style.removeProperty('background');
                node.style.removeProperty('background-color');
            }
        }
    });
    const svgNodes = Array.from(element.querySelectorAll<SVGElement>(
        subtype === 'highlight'
            ? 'svg, path, line, rect, polyline, polygon'
            : 'path, line, polyline, polygon',
    ));
    svgNodes.forEach((node) => {
        node.style.setProperty('color', color);
        node.style.setProperty('--pdf-markup-subtype-color', color);
        if (forceVisible) {
            node.style.setProperty('opacity', '1', 'important');
            node.style.setProperty('visibility', 'visible', 'important');
        }
        const fill = node.getAttribute('fill');
        const stroke = node.getAttribute('stroke');
        if (subtype !== 'highlight' && !isTextMarkupStrokeNode(node, stroke)) {
            if (fill !== 'none') {
                node.style.setProperty('fill', 'transparent');
                node.style.setProperty('fill-opacity', '0');
                node.setAttribute('fill', 'transparent');
                node.setAttribute('fill-opacity', '0');
            }
            return;
        }
        node.style.setProperty('stroke', color);
        node.style.setProperty('stroke-opacity', '1');
        node.setAttribute('stroke', color);
        node.setAttribute('stroke-opacity', '1');
        if (subtype === 'highlight' && (!fill || fill !== 'none')) {
            node.style.setProperty('fill', color);
            node.style.setProperty('fill-opacity', '1');
            node.setAttribute('fill', color);
            node.setAttribute('fill-opacity', '1');
        }
    });
    return subtype === 'highlight'
        || textNodes.length > 0
        || svgNodes.length > 0
        || hasElementDecoration;
}

export function applyAnnotationCommentTextMarkupColor(
    container: HTMLElement,
    comment: IAnnotationCommentSummary,
    color: string,
    opts: {
        forceVisible?: boolean;
        sourceColor?: string | null;
        suppressNativeTextMarkupDecoration?: boolean;
    } = {},
) {
    const normalizedColor = color.trim();
    if (!normalizedColor || !isTextMarkupSubtype(comment.subtype)) {
        return false;
    }

    const candidates = collectTextMarkupElementCandidates(container, comment);
    const subtype = normalizeTextMarkupSubtype(comment.subtype);
    let updated = false;
    const forceVisible = opts.forceVisible !== false;
    const forceAnnotationLayerVisible = forceVisible && subtype === 'highlight';
    const suppressNativeTextMarkupDecoration = opts.suppressNativeTextMarkupDecoration === true
        && subtype !== 'highlight';
    let recoloredElementCount = 0;
    let recoloredVisualCount = 0;
    let recoloredCanvasCount = 0;

    candidates.annotationElements.forEach((element) => {
        if (applyAnnotationLayerTextMarkupColor(element, subtype, normalizedColor, {
            forceVisible: forceAnnotationLayerVisible,
            suppressNativeTextMarkupDecoration,
        })) {
            recoloredElementCount += 1;
            updated = true;
        }
    });

    candidates.pageContexts.forEach((pageContext) => {
        const matchedVisualCount = recolorMatchingHighlightVisuals(
            candidates,
            pageContext.pageContainer,
            pageContext.targetRects,
            normalizedColor,
            subtype,
        );
        if (matchedVisualCount > 0) {
            recoloredVisualCount += matchedVisualCount;
            updated = true;
        }
        pageContext.pageContainer
            .querySelectorAll<HTMLCanvasElement>('canvas')
            .forEach((canvas) => {
                pageContext.targetRects.forEach((targetRect) => {
                    if (recolorCanvasTextMarkupPixelsInRect(
                        canvas,
                        pageContext.pageContainer,
                        targetRect,
                        normalizedColor,
                        subtype,
                        opts.sourceColor ?? null,
                    )) {
                        recoloredCanvasCount += 1;
                        updated = true;
                    }
                });
            });
    });

    BrowserLogger.debug('annotations', 'Applied text markup DOM color', () => ({
        annotationId: comment.annotationId ?? null,
        stableKey: comment.stableKey,
        subtype,
        color: normalizedColor,
        forceVisible: forceAnnotationLayerVisible,
        annotationElementCount: candidates.annotationElements.length,
        pageCount: candidates.pageContexts.length,
        recoloredElementCount,
        recoloredVisualCount,
        recoloredCanvasCount,
        updated,
    }));
    return updated;
}
