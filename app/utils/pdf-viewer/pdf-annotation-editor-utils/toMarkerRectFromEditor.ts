import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';

function findEditorContainers(editor: IPdfjsEditor) {
    const editorDiv = editor.div ?? null;
    const pageContainer = editorDiv?.closest<HTMLElement>('.page_container') ?? null;
    const editorLayer = (
        editorDiv?.closest<HTMLElement>('.annotationEditorLayer')
        ?? editorDiv?.closest<HTMLElement>('.annotation-editor-layer')
        ?? editor.parent?.div
        ?? null
    );
    return {
        editorDiv,
        pageContainer,
        editorLayer,
    };
}

function computeDirectMarkerRect(editor: IPdfjsEditor): IAnnotationMarkerRect | null {
    return normalizeMarkerRect({
        left: editor.x ?? Number.NaN,
        top: editor.y ?? Number.NaN,
        width: editor.width ?? Number.NaN,
        height: editor.height ?? Number.NaN,
    });
}

function hasPositiveSize(rect: DOMRect | null): rect is DOMRect {
    return Boolean(rect && rect.width > 0 && rect.height > 0);
}

function hasMeaningfulLayerOffset(pageRect: DOMRect, layerRect: DOMRect) {
    return Math.abs(layerRect.left - pageRect.left) > 0.5
        || Math.abs(layerRect.top - pageRect.top) > 0.5
        || Math.abs(layerRect.width - pageRect.width) > 0.5
        || Math.abs(layerRect.height - pageRect.height) > 0.5;
}

function convertEditorRectFromLayerSpace(
    editor: IPdfjsEditor,
    pageRect: DOMRect,
    layerRect: DOMRect,
): IAnnotationMarkerRect | null {
    const editorX = editor.x ?? Number.NaN;
    const editorY = editor.y ?? Number.NaN;
    const editorWidth = editor.width ?? Number.NaN;
    const editorHeight = editor.height ?? Number.NaN;
    const widthRatio = layerRect.width / pageRect.width;
    const heightRatio = layerRect.height / pageRect.height;
    return normalizeMarkerRect({
        left: ((layerRect.left - pageRect.left) / pageRect.width) + (editorX * widthRatio),
        top: ((layerRect.top - pageRect.top) / pageRect.height) + (editorY * heightRatio),
        width: editorWidth * widthRatio,
        height: editorHeight * heightRatio,
    });
}

function computeMarkerRectFromBoundingRects(
    editorDiv: HTMLElement,
    pageRect: DOMRect,
): IAnnotationMarkerRect | null {
    const editorRect = editorDiv.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0 || editorRect.width <= 0 || editorRect.height <= 0) {
        return null;
    }
    return normalizeMarkerRect({
        left: (editorRect.left - pageRect.left) / pageRect.width,
        top: (editorRect.top - pageRect.top) / pageRect.height,
        width: editorRect.width / pageRect.width,
        height: editorRect.height / pageRect.height,
    });
}

export function toMarkerRectFromEditor(editor: IPdfjsEditor): IAnnotationMarkerRect | null {
    const {
        editorDiv,
        pageContainer,
        editorLayer,
    } = findEditorContainers(editor);

    const normalizedDirect = computeDirectMarkerRect(editor);

    const pageRect = pageContainer?.getBoundingClientRect() ?? null;
    const layerRect = editorLayer?.getBoundingClientRect() ?? null;
    if (
        hasPositiveSize(pageRect)
        && hasPositiveSize(layerRect)
        && hasMeaningfulLayerOffset(pageRect, layerRect)
    ) {
        const normalizedFromLayerDims = convertEditorRectFromLayerSpace(editor, pageRect, layerRect);
        if (normalizedFromLayerDims) {
            return normalizedFromLayerDims;
        }
    }

    if (normalizedDirect) {
        return normalizedDirect;
    }

    if (!editorDiv || !pageContainer || !pageRect) {
        return null;
    }
    return computeMarkerRectFromBoundingRects(editorDiv, pageRect);
}
