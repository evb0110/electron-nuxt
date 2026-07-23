import { pdfLayerVisualSnapshotActiveClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotActiveClass';
import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import { pdfLayerVisualSnapshotSourceClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotSourceClass';

export function queryPdfLayerVisualSnapshotElements<T extends Element>(
    root: ParentNode | null | undefined,
    selector: string,
) {
    return typeof root?.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll<T>(selector))
        : [];
}

export function getPdfLayerVisualSnapshotCanvasHost(
    pageContainer: HTMLElement | null | undefined,
) {
    return typeof pageContainer?.querySelector === 'function'
        ? pageContainer.querySelector<HTMLElement>('.page_canvas__render-layer')
            ?? pageContainer.querySelector<HTMLElement>('.page_canvas, .canvasWrapper')
            ?? null
        : null;
}

export function getPdfLayerVisualSnapshotAnnotationLayer(
    pageContainer: HTMLElement | null | undefined,
) {
    return typeof pageContainer?.querySelector === 'function'
        ? pageContainer.querySelector<HTMLElement>('.annotation-layer, .annotationLayer') ?? null
        : null;
}

export function getPdfLayerVisualSnapshotAnnotationEditorLayer(
    pageContainer: HTMLElement | null | undefined,
) {
    return typeof pageContainer?.querySelector === 'function'
        ? pageContainer.querySelector<HTMLElement>('.annotation-editor-layer, .annotationEditorLayer') ?? null
        : null;
}

export function isPdfLayerVisualSnapshotElement(element: Element) {
    return element.classList.contains(pdfLayerVisualSnapshotClass)
        || Boolean(element.closest?.(`.${pdfLayerVisualSnapshotClass}`));
}

export function isPdfLayerVisualSnapshotSourceElement(element: Element) {
    return element.classList.contains(pdfLayerVisualSnapshotSourceClass)
        || Boolean(element.closest?.(`.${pdfLayerVisualSnapshotSourceClass}`));
}

function isInsideActivePdfLayerVisualSnapshotHost(element: Element) {
    return element.classList.contains(pdfLayerVisualSnapshotActiveClass)
        || Boolean(element.closest?.(`.${pdfLayerVisualSnapshotActiveClass}`));
}

export function isPdfLayerVisualElementPotentiallyPainted(
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
            && isInsideActivePdfLayerVisualSnapshotHost(element);
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

export function isPdfLayerVisualElementVisiblyPainted(element: Element) {
    if (
        isPdfLayerVisualSnapshotElement(element)
        || isPdfLayerVisualSnapshotSourceElement(element)
        || isInsideActivePdfLayerVisualSnapshotHost(element)
    ) {
        return false;
    }
    return isPdfLayerVisualElementPotentiallyPainted(element, {ignoreActiveSnapshotHostVisibility: false});
}
