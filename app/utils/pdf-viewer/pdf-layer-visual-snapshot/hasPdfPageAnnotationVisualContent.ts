import { hasPdfPageDrawLayerVisualContent } from '@app/utils/pdf-viewer/pdf-layer-visual-snapshot/hasPdfPageDrawLayerVisualContent';
import { pdfLayerVisualSnapshotActiveClass } from '@app/utils/pdf-viewer/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotActiveClass';
import { pdfLayerVisualSnapshotClass } from '@app/utils/pdf-viewer/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import { pdfLayerVisualSnapshotSourceClass } from '@app/utils/pdf-viewer/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotSourceClass';

const ANNOTATION_LAYER_VISUAL_SELECTOR = [
    '.editorAnnotation',
    '.highlightAnnotation',
    '.underlineAnnotation',
    '.strikeoutAnnotation',
    '.squigglyAnnotation',
    '[data-annotation-id]',
].join(', ');

function queryAll<T extends Element>(
    root: ParentNode | null | undefined,
    selector: string,
) {
    return typeof root?.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll<T>(selector))
        : [];
}

function getChildren(element: Element | null | undefined) {
    return element?.children
        ? Array.from(element.children)
        : [];
}

function getAnnotationLayer(pageContainer: HTMLElement | null | undefined) {
    return typeof pageContainer?.querySelector === 'function'
        ? pageContainer.querySelector<HTMLElement>('.annotation-layer, .annotationLayer') ?? null
        : null;
}

function getAnnotationEditorLayer(pageContainer: HTMLElement | null | undefined) {
    return typeof pageContainer?.querySelector === 'function'
        ? pageContainer.querySelector<HTMLElement>('.annotation-editor-layer, .annotationEditorLayer') ?? null
        : null;
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

function hasAnnotationLayerVisualContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return queryAll(layer, ANNOTATION_LAYER_VISUAL_SELECTOR)
        .some(isElementVisiblyPainted);
}

function hasAnnotationEditorLayerVisualContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return getChildren(layer)
        .some(isElementVisiblyPainted);
}

export function hasPdfPageAnnotationVisualContent(
    pageContainer: HTMLElement | null | undefined,
) {
    return (
        hasPdfPageDrawLayerVisualContent(pageContainer)
        || hasAnnotationLayerVisualContent(getAnnotationLayer(pageContainer))
        || hasAnnotationEditorLayerVisualContent(getAnnotationEditorLayer(pageContainer))
    );
}
