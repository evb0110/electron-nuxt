import { pdfLayerVisualSnapshotActiveClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotActiveClass';
import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import { pdfLayerVisualSnapshotSourceClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotSourceClass';

const DRAW_LAYER_VISUAL_SELECTOR = [
    ':scope > svg.highlight',
    ':scope > svg.highlightOutline',
    ':scope > svg.draw',
    ':scope > svg.pdf-highlight-composite-overlay',
].join(', ');

function queryAll<T extends Element>(
    root: ParentNode | null | undefined,
    selector: string,
) {
    return typeof root?.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll<T>(selector))
        : [];
}

function isSnapshotElement(element: Element) {
    return element.classList.contains(pdfLayerVisualSnapshotClass)
        || Boolean(element.closest?.(`.${pdfLayerVisualSnapshotClass}`));
}

function isSnapshotSourceElement(element: Element) {
    return element.classList.contains(pdfLayerVisualSnapshotSourceClass)
        || Boolean(element.closest?.(`.${pdfLayerVisualSnapshotSourceClass}`));
}

function isInsideActiveSnapshotHost(element: Element) {
    return element.classList.contains(pdfLayerVisualSnapshotActiveClass)
        || Boolean(element.closest?.(`.${pdfLayerVisualSnapshotActiveClass}`));
}

function isElementVisiblyPainted(element: Element) {
    if (
        isSnapshotElement(element)
        || isSnapshotSourceElement(element)
        || isInsideActiveSnapshotHost(element)
    ) {
        return false;
    }
    return isElementPotentiallyPainted(element, { ignoreActiveSnapshotHostVisibility: false });
}

function isElementPotentiallyPainted(
    element: Element,
    options: { ignoreActiveSnapshotHostVisibility: boolean },
) {
    const isHtmlElement = typeof HTMLElement !== 'undefined' && element instanceof HTMLElement;
    const isSvgElement = typeof SVGElement !== 'undefined' && element instanceof SVGElement;
    if (!isHtmlElement && !isSvgElement) {
        return false;
    }
    if (isHtmlElement && element.hidden) {
        return false;
    }

    try {
        const style = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(element)
            : null;
        const activeSnapshotSuppressed = options.ignoreActiveSnapshotHostVisibility
            && isInsideActiveSnapshotHost(element);
        if (
            style
            && (
                style.display === 'none'
                || (style.visibility === 'hidden' && !activeSnapshotSuppressed)
                || Number(style.opacity || '1') <= 0
            )
        ) {
            return false;
        }

        const rect = typeof element.getBoundingClientRect === 'function'
            ? element.getBoundingClientRect()
            : null;
        return !rect || (rect.width > 0 && rect.height > 0);
    } catch {
        return true;
    }
}

export function hasPdfDrawLayerVisualContent(canvasHost: HTMLElement | null | undefined) {
    if (!canvasHost) {
        return false;
    }

    return queryAll<SVGElement>(
        canvasHost,
        DRAW_LAYER_VISUAL_SELECTOR,
    ).some(isElementVisiblyPainted);
}
