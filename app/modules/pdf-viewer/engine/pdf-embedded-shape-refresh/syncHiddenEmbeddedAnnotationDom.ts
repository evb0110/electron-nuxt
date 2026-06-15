import { normalizePdfJsAnnotationId } from '@app/utils/pdfAnnotationRefs';

export interface ISyncHiddenEmbeddedAnnotationDomOptions {
    container: HTMLElement | null;
    hiddenAnnotationIds: ReadonlySet<string>;
    managedAnnotationIds?: ReadonlySet<string> | undefined;
}

export interface ISyncHiddenEmbeddedAnnotationDomResult {
    removedCount: number;
    deferredManagedAnnotationCount: number;
}

export interface IResolveHiddenEmbeddedAnnotationIdsForPageContainerOptions {
    hiddenAnnotationIds: ReadonlySet<string>;
    managedAnnotationIds?: ReadonlySet<string> | undefined;
    pageContainer?: HTMLElement | null | undefined;
}

export interface IShouldHideHiddenEmbeddedAnnotationOptions {
    annotationId: string | null | undefined;
    hiddenAnnotationIds: ReadonlySet<string>;
    managedAnnotationIds?: ReadonlySet<string> | undefined;
    pageContainer?: HTMLElement | null | undefined;
}

function toNormalizedAnnotationIdSet(ids: ReadonlySet<string> | undefined) {
    const normalizedIds = new Set<string>();
    ids?.forEach((id) => {
        const normalizedId = normalizePdfJsAnnotationId(id);
        if (normalizedId) {
            normalizedIds.add(normalizedId);
        }
    });
    return normalizedIds;
}

function getElementAnnotationId(element: HTMLElement) {
    return normalizePdfJsAnnotationId(
        element.dataset.annotationId ?? element.getAttribute('data-annotation-id'),
    );
}

function isAppShapeOverlayElement(element: Element) {
    return typeof element.closest === 'function'
        && Boolean(element.closest('.pdf-shape-overlay'));
}

function getOverlayCandidateAnnotationId(element: Element) {
    const datasetAnnotationId = (
        'dataset' in element
        && typeof (element as {dataset?: {annotationId?: unknown}}).dataset?.annotationId === 'string'
    )
        ? (element as {dataset: {annotationId: string}}).dataset.annotationId
        : undefined;
    return normalizePdfJsAnnotationId(
        datasetAnnotationId ?? element.getAttribute('data-annotation-id'),
    );
}

function getElementStyle(element: Element) {
    if (
        typeof window === 'undefined'
        || typeof window.getComputedStyle !== 'function'
    ) {
        return null;
    }

    try {
        return window.getComputedStyle(element);
    } catch {
        return null;
    }
}

function isStyleVisible(element: Element) {
    const style = getElementStyle(element);
    if (!style) {
        return true;
    }

    return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
}

function hasVisibleSvgGeometry(element: Element) {
    const getBBox = (element as SVGGraphicsElement).getBBox;
    if (typeof getBBox !== 'function') {
        return true;
    }

    try {
        const bbox = getBBox.call(element);
        return bbox.width > 0 || bbox.height > 0;
    } catch {
        return false;
    }
}

function isOverlayCandidatePaintReady(element: Element) {
    const overlay = typeof element.closest === 'function'
        ? element.closest('.pdf-shape-overlay.has-shapes')
        : null;
    if (overlay && !isStyleVisible(overlay)) {
        return false;
    }

    return isStyleVisible(element) && hasVisibleSvgGeometry(element);
}

function hasManagedShapeOverlayForAnnotation(
    pageContainer: HTMLElement | null | undefined,
    annotationId: string | null | undefined,
) {
    const normalizedAnnotationId = normalizePdfJsAnnotationId(annotationId);
    if (!pageContainer || !normalizedAnnotationId) {
        return false;
    }

    return Array.from(
        pageContainer.querySelectorAll<Element>('.pdf-shape-overlay.has-shapes [data-annotation-id]'),
    ).some(element => (
        getOverlayCandidateAnnotationId(element) === normalizedAnnotationId
        && isOverlayCandidatePaintReady(element)
    ));
}

function getPageContainerForAnnotationElement(element: HTMLElement) {
    return typeof element.closest === 'function'
        ? element.closest<HTMLElement>('.page_container')
        : null;
}

export function shouldHideHiddenEmbeddedAnnotation({
    annotationId,
    hiddenAnnotationIds,
    managedAnnotationIds,
    pageContainer,
}: IShouldHideHiddenEmbeddedAnnotationOptions) {
    const normalizedAnnotationId = normalizePdfJsAnnotationId(annotationId);
    if (!normalizedAnnotationId) {
        return false;
    }

    return resolveHiddenEmbeddedAnnotationIdsForPageContainer({
        hiddenAnnotationIds,
        managedAnnotationIds,
        pageContainer,
    }).has(normalizedAnnotationId);
}

export function resolveHiddenEmbeddedAnnotationIdsForPageContainer({
    hiddenAnnotationIds,
    managedAnnotationIds,
    pageContainer,
}: IResolveHiddenEmbeddedAnnotationIdsForPageContainerOptions) {
    const normalizedHiddenIds = toNormalizedAnnotationIdSet(hiddenAnnotationIds);
    if (normalizedHiddenIds.size === 0) {
        return normalizedHiddenIds;
    }

    const normalizedManagedIds = toNormalizedAnnotationIdSet(managedAnnotationIds);
    if (normalizedManagedIds.size === 0) {
        return normalizedHiddenIds;
    }

    const visibleUntilOverlayIds = new Set(normalizedHiddenIds);
    normalizedManagedIds.forEach((annotationId) => {
        if (!hasManagedShapeOverlayForAnnotation(pageContainer, annotationId)) {
            visibleUntilOverlayIds.delete(annotationId);
        }
    });
    return visibleUntilOverlayIds;
}

export function syncHiddenEmbeddedAnnotationDom({
    container,
    hiddenAnnotationIds,
    managedAnnotationIds,
}: ISyncHiddenEmbeddedAnnotationDomOptions): ISyncHiddenEmbeddedAnnotationDomResult {
    const result: ISyncHiddenEmbeddedAnnotationDomResult = {
        removedCount: 0,
        deferredManagedAnnotationCount: 0,
    };
    if (!container) {
        return result;
    }

    const normalizedHiddenIds = toNormalizedAnnotationIdSet(hiddenAnnotationIds);
    if (normalizedHiddenIds.size === 0) {
        return result;
    }

    const normalizedManagedIds = toNormalizedAnnotationIdSet(managedAnnotationIds);
    container.querySelectorAll<HTMLElement>('[data-annotation-id]').forEach((element) => {
        if (isAppShapeOverlayElement(element)) {
            return;
        }

        const annotationId = getElementAnnotationId(element);
        if (!annotationId || !normalizedHiddenIds.has(annotationId)) {
            return;
        }

        if (
            normalizedManagedIds.has(annotationId)
            && !hasManagedShapeOverlayForAnnotation(
                getPageContainerForAnnotationElement(element),
                annotationId,
            )
        ) {
            result.deferredManagedAnnotationCount += 1;
            return;
        }

        element.remove();
        result.removedCount += 1;
    });

    return result;
}
