import { clamp } from 'es-toolkit/math';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import type {
    IPdfNavigationRequest,
    TPdfNavigationTarget,
} from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';
import { resolveBookmarkDestinationTarget } from '@app/utils/pdfOutlineHelpers';

export interface IResolvedPdfNavigationTarget {
    page: number;
    rect: IAnnotationMarkerRect | null;
}

function normalizedPointRect(top: number): IAnnotationMarkerRect {
    return {
        left: 0.5,
        top: clamp(top, 0, 1),
        width: 0,
        height: 0,
    };
}

export async function resolvePdfNavigationTarget(
    target: TPdfNavigationTarget,
    pdfDocument: PDFDocumentProxy | null,
): Promise<IResolvedPdfNavigationTarget> {
    if (target.kind === 'page') {
        return {
            page: target.page,
            rect: null,
        };
    }
    if (target.kind === 'rect') {
        return {
            page: target.page,
            rect: target.rect,
        };
    }
    if (target.kind === 'text-anchor') {
        return {
            page: target.page,
            rect: null,
        };
    }
    if (!pdfDocument) throw new DOMException('Named destination requires a PDF document', 'AbortError');
    const destination = await resolveBookmarkDestinationTarget(pdfDocument, target.destination);
    if (!destination) throw new DOMException('Named destination could not be resolved', 'AbortError');
    return {
        page: destination.page,
        rect: typeof destination.pageYRatio === 'number'
            ? normalizedPointRect(destination.pageYRatio)
            : null,
    };
}

export function resolvePdfNavigationAnchor(
    request: IPdfNavigationRequest,
    target: IResolvedPdfNavigationTarget,
): IPdfSemanticAnchor {
    const rect = target.rect;
    if (request.alignment === 'rect-center' && rect) {
        return {
            page: target.page,
            pageXFraction: clamp(rect.left + rect.width / 2, 0, 1),
            pageYFraction: clamp(rect.top + rect.height / 2, 0, 1),
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
            affinity: 'center',
        };
    }
    return {
        page: target.page,
        pageXFraction: 0.5,
        pageYFraction: rect ? clamp(rect.top, 0, 1) : 0,
        viewportXFraction: 0.5,
        viewportYFraction: 0,
        affinity: 'start',
    };
}

export function resolveTextAnchorRect(
    container: HTMLElement,
    target: Extract<TPdfNavigationTarget, {kind: 'text-anchor'}>,
): IAnnotationMarkerRect | null {
    const page = container.querySelector<HTMLElement>(`.page_container[data-page="${target.page}"]`);
    const textLayer = page?.querySelector<HTMLElement>('.text-layer, .textLayer');
    if (!page || !textLayer) {
        return null;
    }
    const spans = Array.from(textLayer.querySelectorAll<HTMLElement>('span'));
    const needle = `${target.prefix ?? ''}${target.text}${target.suffix ?? ''}`.normalize('NFKC');
    const matchingSpan = spans.find((span) => {
        const value = (span.textContent ?? '').normalize('NFKC');
        return value.includes(needle) || value.includes(target.text.normalize('NFKC'));
    });
    if (!matchingSpan) {
        return null;
    }
    const pageRect = page.getBoundingClientRect();
    const rect = matchingSpan.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }
    return {
        left: clamp((rect.left - pageRect.left) / pageRect.width, 0, 1),
        top: clamp((rect.top - pageRect.top) / pageRect.height, 0, 1),
        width: clamp(rect.width / pageRect.width, 0, 1),
        height: clamp(rect.height / pageRect.height, 0, 1),
    };
}

export function isPdfNavigationReady(
    container: HTMLElement,
    page: number,
    readiness: IPdfNavigationRequest['readiness'],
    isCanvasFresh: (page: number) => boolean,
) {
    if (readiness === 'metrics') {
        return true;
    }
    if (!isCanvasFresh(page)) {
        return false;
    }
    if (readiness === 'page-canvas') {
        return true;
    }
    const pageElement = container.querySelector<HTMLElement>(`.page_container[data-page="${page}"]`);
    if (readiness === 'text-layer') {
        return Boolean(pageElement?.querySelector('.text-layer, .textLayer'));
    }
    return Boolean(pageElement?.querySelector('.annotation-editor-layer, .annotationEditorLayer'));
}
