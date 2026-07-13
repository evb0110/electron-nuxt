import { combinePdfLayerVisualSnapshotReleases } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/combinePdfLayerVisualSnapshotReleases';
import { hasPdfDrawLayerVisualContent } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfDrawLayerVisualContent';
import { pdfLayerVisualSnapshotActiveClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotActiveClass';
import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import { pdfLayerVisualSnapshotSourceClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotSourceClass';
import { preservePdfDrawLayerVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfDrawLayerVisualSnapshot';
import { preservePdfLayerVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfLayerVisualSnapshot';

const TEXT_MARKUP_EDITOR_SELECTOR = [
    '.highlightEditor',
    '[role="mark"]',
    '[class*="pdf-markup-subtype"]',
].join(', ');

const DUPLICATE_TEXT_MARKUP_EDITOR_SELECTOR = [
    '.highlightEditor:not([class*="pdf-markup-subtype"])',
    '[role="mark"]:not([class*="pdf-markup-subtype"])',
].join(', ');

function queryAll<T extends Element>(
    root: ParentNode | null | undefined,
    selector: string,
) {
    return typeof root?.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll<T>(selector))
        : [];
}

function getCanvasHost(pageContainer: HTMLElement | null | undefined) {
    return typeof pageContainer?.querySelector === 'function'
        ? pageContainer.querySelector<HTMLElement>('.page_canvas__render-layer')
            ?? pageContainer.querySelector<HTMLElement>('.page_canvas, .canvasWrapper')
            ?? null
        : null;
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

function hasTextMarkupEditorLayerVisualContent(layer: HTMLElement | null | undefined) {
    if (!layer || layer.hidden) {
        return false;
    }

    return queryAll(layer, TEXT_MARKUP_EDITOR_SELECTOR)
        .some(isElementVisiblyPainted);
}

export function preservePdfPageAnnotationVisualSnapshot(
    pageContainer: HTMLElement | null | undefined,
    annotationEditorLayer: HTMLElement | null | undefined,
) {
    if (
        !pageContainer
        || typeof pageContainer.querySelector !== 'function'
        || pageContainer.querySelector(`.${pdfLayerVisualSnapshotClass}`)
    ) {
        return null;
    }

    const canvasHost = getCanvasHost(pageContainer);
    const editorLayer = annotationEditorLayer ?? getAnnotationEditorLayer(pageContainer);
    const hasDrawLayerVisuals = hasPdfDrawLayerVisualContent(canvasHost);
    const hasTextMarkupEditors = hasTextMarkupEditorLayerVisualContent(editorLayer);
    const annotationLayerExcludeSelectors = hasDrawLayerVisuals || hasTextMarkupEditors
        ? ['.editorAnnotation']
        : [];
    const editorLayerExcludeSelectors = hasDrawLayerVisuals
        ? [DUPLICATE_TEXT_MARKUP_EDITOR_SELECTOR]
        : [];
    return combinePdfLayerVisualSnapshotReleases([
        preservePdfLayerVisualSnapshot(getAnnotationLayer(pageContainer), {
            excludeSelectors: annotationLayerExcludeSelectors,
            suppressLiveContentWhenEmpty: annotationLayerExcludeSelectors.length > 0,
        }),
        preservePdfDrawLayerVisualSnapshot(canvasHost),
        preservePdfLayerVisualSnapshot(editorLayer, {
            excludeSelectors: editorLayerExcludeSelectors,
            suppressLiveContentWhenEmpty: hasDrawLayerVisuals || editorLayerExcludeSelectors.length > 0,
        }),
    ]);
}
