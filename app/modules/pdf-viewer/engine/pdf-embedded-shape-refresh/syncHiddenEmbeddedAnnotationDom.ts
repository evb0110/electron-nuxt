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

export function hasManagedShapeOverlayForPageContainer(
    pageContainer: HTMLElement | null | undefined,
) {
    return Boolean(pageContainer?.querySelector('.pdf-shape-overlay.has-shapes'));
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
    if (
        normalizedManagedIds.size === 0
        || hasManagedShapeOverlayForPageContainer(pageContainer)
    ) {
        return normalizedHiddenIds;
    }

    const visibleUntilOverlayIds = new Set(normalizedHiddenIds);
    normalizedManagedIds.forEach((annotationId) => {
        visibleUntilOverlayIds.delete(annotationId);
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
        const annotationId = getElementAnnotationId(element);
        if (!annotationId || !normalizedHiddenIds.has(annotationId)) {
            return;
        }

        if (
            normalizedManagedIds.has(annotationId)
            && !hasManagedShapeOverlayForPageContainer(getPageContainerForAnnotationElement(element))
        ) {
            result.deferredManagedAnnotationCount += 1;
            return;
        }

        element.remove();
        result.removedCount += 1;
    });

    return result;
}
