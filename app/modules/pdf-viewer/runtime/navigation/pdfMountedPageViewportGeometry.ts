import {clamp} from 'es-toolkit/math';
import type {IPdfSemanticAnchor} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import {getRequestAnchor} from '@app/modules/pdf-viewer/runtime/navigation/pdfNavigationRequestAnchors';

function getMountedPageElement(container: HTMLElement, pageNumber: number) {
    return container.querySelector<HTMLElement>(
        `.page_container[data-page="${String(Math.max(1, Math.trunc(pageNumber)))}"]`,
    );
}

export function hasMeasurableMountedPage(container: HTMLElement, pageNumber: number) {
    const rect = getMountedPageElement(container, pageNumber)?.getBoundingClientRect();
    return rect !== undefined && rect.width > 0 && rect.height > 0;
}

export function resolvePagedAnchorFromViewport(
    container: HTMLElement,
    pageNumber: number,
    viewportFraction = {
        x: 0.5,
        y: 0.5,
    },
): IPdfSemanticAnchor {
    const page = Math.max(1, Math.trunc(pageNumber));
    const element = getMountedPageElement(container, page);
    if (!element) {
        return getRequestAnchor(undefined, page);
    }
    const viewportRect = container.getBoundingClientRect();
    const pageRect = element.getBoundingClientRect();
    const x = viewportRect.left + container.clientWidth * viewportFraction.x;
    const y = viewportRect.top + container.clientHeight * viewportFraction.y;
    return {
        page,
        pageXFraction: clamp((x - pageRect.left) / Math.max(1, pageRect.width), 0, 1),
        pageYFraction: clamp((y - pageRect.top) / Math.max(1, pageRect.height), 0, 1),
        viewportXFraction: clamp(viewportFraction.x, 0, 1),
        viewportYFraction: clamp(viewportFraction.y, 0, 1),
        affinity: 'center',
    };
}

export function resolvePagedScrollForAnchor(
    container: HTMLElement,
    anchor: IPdfSemanticAnchor,
    scaledMargin: number,
) {
    const element = getMountedPageElement(container, anchor.page);
    if (!element) {
        return {
            left: container.scrollLeft,
            top: container.scrollTop,
        };
    }
    const viewportRect = container.getBoundingClientRect();
    const pageRect = element.getBoundingClientRect();
    const pageContentLeft = container.scrollLeft + pageRect.left - viewportRect.left;
    const pageContentTop = container.scrollTop + pageRect.top - viewportRect.top;
    return {
        left: clamp(
            pageContentLeft + clamp(anchor.pageXFraction, 0, 1) * pageRect.width
                - clamp(anchor.viewportXFraction, 0, 1) * container.clientWidth,
            0,
            Math.max(0, container.scrollWidth - container.clientWidth),
        ),
        top: clamp(
            pageContentTop + clamp(anchor.pageYFraction, 0, 1) * pageRect.height
                - clamp(anchor.viewportYFraction, 0, 1) * container.clientHeight
                - (anchor.affinity === 'start' ? scaledMargin : 0),
            0,
            Math.max(0, container.scrollHeight - container.clientHeight),
        ),
    };
}
