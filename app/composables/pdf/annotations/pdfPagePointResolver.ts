import type { Ref } from 'vue';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { IPagePointTarget } from '@app/composables/pdf/annotations/types';
import {
    clamp01,
    normalizeMarkerRect,
} from '@app/composables/pdf/annotationGeometry';
import { BrowserLogger } from '@app/utils/browserLogger';

const DEFAULT_POINT_MARKER_SIZE = 0.0016;
const NOTE_PLACEMENT_LOG_SECTION = 'note-placement';
const MAX_PAGE_CANDIDATE_LOG_ENTRIES = 14;

export interface INotePlacementDiagnosticsContext {
    attemptId?: string;
    source?: string;
    clickCapturedAtMs?: number;
    clickMeta?: Record<string, unknown>;
}

interface IPageCandidateLogEntry {
    pageNumber: number | null;
    inside: boolean;
    distanceSquared: number;
    rect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
    };
}

interface IPageGeometryCandidate {
    element: HTMLElement;
    rect: DOMRect;
    inside: boolean;
    distanceSquared: number;
}

interface IGeometryResolution {
    pageContainer: HTMLElement | null;
    source: 'inside' | 'nearest' | 'none';
    candidates: IPageCandidateLogEntry[] | null;
}

interface IPagePointResolutionInputs {
    targetPageContainer: HTMLElement | null;
    documentPointContainer: HTMLElement | null;
    geometryResolution: IGeometryResolution;
    byTargetPage: number | null;
    byElementFromPointPage: number | null;
    byGeometryPage: number | null;
}

interface IPagePointResolutionSelection {
    pageContainer: HTMLElement | null;
    selectedSource: string;
    targetConflictsWithElementPoint: boolean;
    targetConflictsWithGeometry: boolean;
    hasTargetConflict: boolean;
}

interface IPagePointPageNumbers {
    byTargetPage: number | null;
    byElementFromPointPage: number | null;
    byGeometryPage: number | null;
}

interface IPdfPagePointResolverOptions {
    viewerContainer: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
}

export function markerRectFromPoint(pageX: number, pageY: number): IAnnotationMarkerRect | null {
    return normalizeMarkerRect({
        left: clamp01(pageX) - DEFAULT_POINT_MARKER_SIZE / 2,
        top: clamp01(pageY) - DEFAULT_POINT_MARKER_SIZE / 2,
        width: DEFAULT_POINT_MARKER_SIZE,
        height: DEFAULT_POINT_MARKER_SIZE,
    });
}

function roundForLog(value: number, digits = 3) {
    if (!Number.isFinite(value)) {
        return value;
    }
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function toRectLog(rect: DOMRect | {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}) {
    return {
        left: roundForLog(rect.left),
        top: roundForLog(rect.top),
        right: roundForLog(rect.right),
        bottom: roundForLog(rect.bottom),
        width: roundForLog(rect.width),
        height: roundForLog(rect.height),
    };
}

function isPointInsideRect(clientX: number, clientY: number, rect: DOMRect) {
    return (
        clientX >= rect.left
        && clientX <= rect.right
        && clientY >= rect.top
        && clientY <= rect.bottom
    );
}

function squaredDistanceToRect(clientX: number, clientY: number, rect: DOMRect) {
    const dx = clientX < rect.left
        ? rect.left - clientX
        : (clientX > rect.right ? clientX - rect.right : 0);
    const dy = clientY < rect.top
        ? rect.top - clientY
        : (clientY > rect.bottom ? clientY - rect.bottom : 0);
    return dx * dx + dy * dy;
}

function measurePageGeometryCandidate(
    element: HTMLElement,
    clientX: number,
    clientY: number,
): IPageGeometryCandidate | null {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    return {
        element,
        rect,
        inside: isPointInsideRect(clientX, clientY, rect),
        distanceSquared: squaredDistanceToRect(clientX, clientY, rect),
    };
}

function parsePageNumberFromContainer(pageContainer: HTMLElement | null) {
    if (!pageContainer?.dataset.page) {
        return null;
    }
    const parsed = Number(pageContainer.dataset.page);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
}

function toPageCandidateLogEntry(candidate: IPageGeometryCandidate): IPageCandidateLogEntry {
    return {
        pageNumber: parsePageNumberFromContainer(candidate.element),
        inside: candidate.inside,
        distanceSquared: roundForLog(candidate.distanceSquared),
        rect: toRectLog(candidate.rect),
    };
}

function createEmptyGeometryResolution(collectCandidates: boolean): IGeometryResolution {
    return {
        pageContainer: null,
        source: 'none',
        candidates: collectCandidates ? [] : null,
    };
}

function createGeometryResolution(
    candidate: IPageGeometryCandidate,
    source: IGeometryResolution['source'],
    candidates: IPageCandidateLogEntry[],
    collectCandidates: boolean,
): IGeometryResolution {
    return {
        pageContainer: candidate.element,
        source,
        candidates: collectCandidates ? candidates : null,
    };
}

function addGeometryCandidateLogEntry(
    candidate: IPageGeometryCandidate,
    candidates: IPageCandidateLogEntry[],
    collectCandidates: boolean,
) {
    if (collectCandidates && candidates.length < MAX_PAGE_CANDIDATE_LOG_ENTRIES) {
        candidates.push(toPageCandidateLogEntry(candidate));
    }
}

function chooseFinalGeometryResolution(
    insideMatch: IPageGeometryCandidate | null,
    nearest: IPageGeometryCandidate | null,
    candidates: IPageCandidateLogEntry[],
    collectCandidates: boolean,
) {
    if (insideMatch) {
        return createGeometryResolution(insideMatch, 'inside', candidates, collectCandidates);
    }
    if (nearest) {
        return createGeometryResolution(nearest, 'nearest', candidates, collectCandidates);
    }
    return createEmptyGeometryResolution(collectCandidates);
}

export function scanPageGeometryCandidates(
    pages: HTMLElement[],
    clientX: number,
    clientY: number,
    collectCandidates: boolean,
): IGeometryResolution | null {
    let nearest: IPageGeometryCandidate | null = null;
    let insideMatch: IPageGeometryCandidate | null = null;
    const candidates: IPageCandidateLogEntry[] = [];

    for (const element of pages) {
        const candidate = measurePageGeometryCandidate(element, clientX, clientY);
        if (!candidate) {
            continue;
        }
        addGeometryCandidateLogEntry(candidate, candidates, collectCandidates);
        if (candidate.inside && !collectCandidates) {
            return createGeometryResolution(candidate, 'inside', candidates, collectCandidates);
        }
        if (candidate.inside && !insideMatch) {
            insideMatch = candidate;
        }
        if (!nearest || candidate.distanceSquared < nearest.distanceSquared) {
            nearest = candidate;
        }
    }

    return chooseFinalGeometryResolution(insideMatch, nearest, candidates, collectCandidates);
}

export function selectPagePointResolution(inputs: IPagePointResolutionInputs): IPagePointResolutionSelection {
    const {
        targetPageContainer,
        documentPointContainer,
        geometryResolution,
        byTargetPage,
        byElementFromPointPage,
        byGeometryPage,
    } = inputs;
    const targetConflictsWithElementPoint = (
        byTargetPage !== null
        && byElementFromPointPage !== null
        && byTargetPage !== byElementFromPointPage
    );
    const targetConflictsWithGeometry = (
        byTargetPage !== null
        && byGeometryPage !== null
        && byTargetPage !== byGeometryPage
    );
    const hasTargetConflict = targetConflictsWithElementPoint || targetConflictsWithGeometry;

    if (targetPageContainer && !hasTargetConflict) {
        return {
            pageContainer: targetPageContainer,
            selectedSource: 'target-element',
            targetConflictsWithElementPoint,
            targetConflictsWithGeometry,
            hasTargetConflict,
        };
    }
    if (documentPointContainer) {
        return {
            pageContainer: documentPointContainer,
            selectedSource: 'document.elementFromPoint',
            targetConflictsWithElementPoint,
            targetConflictsWithGeometry,
            hasTargetConflict,
        };
    }
    if (geometryResolution.pageContainer) {
        return {
            pageContainer: geometryResolution.pageContainer,
            selectedSource: geometryResolution.source === 'inside' ? 'geometry-inside' : 'geometry-nearest',
            targetConflictsWithElementPoint,
            targetConflictsWithGeometry,
            hasTargetConflict,
        };
    }
    return {
        pageContainer: targetPageContainer,
        selectedSource: targetPageContainer ? 'target-element-conflicted-fallback' : 'none',
        targetConflictsWithElementPoint,
        targetConflictsWithGeometry,
        hasTargetConflict,
    };
}

export function buildPagePointTargetFromContainer(
    pageContainer: HTMLElement,
    clientX: number,
    clientY: number,
    selectedSource: string,
    currentPage: number,
    diagnostics?: INotePlacementDiagnosticsContext,
): IPagePointTarget | null {
    const rect = pageContainer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        if (diagnostics) {
            BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Resolved quick-note page container has invalid rect', {
                attemptId: diagnostics.attemptId ?? null,
                selectedSource,
                pageNumberFromDataset: pageContainer.dataset.page ?? null,
                rect: toRectLog(rect),
            });
        }
        return null;
    }
    const parsedPageNumber = pageContainer.dataset.page ? Number(pageContainer.dataset.page) : currentPage;
    const pageNumber = Number.isFinite(parsedPageNumber) && parsedPageNumber > 0 ? parsedPageNumber : null;
    if (pageNumber === null) {
        if (diagnostics) {
            BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Resolved quick-note page container has invalid page number', {
                attemptId: diagnostics.attemptId ?? null,
                selectedSource,
                datasetPage: pageContainer.dataset.page ?? null,
                fallbackCurrentPage: currentPage,
            });
        }
        return null;
    }
    return {
        pageContainer,
        pageNumber,
        pageX: clamp01((clientX - rect.left) / rect.width),
        pageY: clamp01((clientY - rect.top) / rect.height),
    };
}

export function createPdfPagePointResolver(options: IPdfPagePointResolverOptions) {
    const {
        viewerContainer,
        currentPage,
    } = options;

    function summarizeElementForLog(element: HTMLElement | null) {
        if (!element) {
            return null;
        }
        return {
            tag: element.tagName.toLowerCase(),
            id: element.id || null,
            classList: Array.from(element.classList).slice(0, 8),
            dataPage: parsePageNumberFromContainer(element.closest<HTMLElement>('.page_container')),
            role: element.getAttribute('role'),
        };
    }

    function summarizeVisiblePageWindowForLog() {
        const container = viewerContainer.value;
        if (!container) {
            return null;
        }
        const viewportTop = container.scrollTop;
        const viewportBottom = viewportTop + container.clientHeight;
        const visiblePages: number[] = [];
        const pageContainers = container.querySelectorAll<HTMLElement>('.page_container');
        for (const pageContainer of pageContainers) {
            const pageNumber = parsePageNumberFromContainer(pageContainer);
            if (!pageNumber) {
                continue;
            }
            const pageTop = pageContainer.offsetTop;
            const pageBottom = pageTop + pageContainer.offsetHeight;
            if (pageBottom < viewportTop || pageTop > viewportBottom) {
                continue;
            }
            visiblePages.push(pageNumber);
        }
        return {
            start: visiblePages[0] ?? null,
            end: visiblePages.at(-1) ?? null,
            count: visiblePages.length,
            sample: visiblePages.slice(0, MAX_PAGE_CANDIDATE_LOG_ENTRIES),
            viewportTop: roundForLog(viewportTop),
            viewportBottom: roundForLog(viewportBottom),
        };
    }

    function resolvePageContainerByGeometry(
        clientX: number,
        clientY: number,
        resolverOptions: { collectCandidates?: boolean } = {},
    ): IGeometryResolution {
        const collectCandidates = resolverOptions.collectCandidates ?? false;
        const container = viewerContainer.value;
        if (!container) {
            return createEmptyGeometryResolution(collectCandidates);
        }
        const pages = Array.from(container.querySelectorAll<HTMLElement>('.page_container'));
        if (pages.length === 0) {
            return createEmptyGeometryResolution(collectCandidates);
        }

        return scanPageGeometryCandidates(pages, clientX, clientY, collectCandidates)
            ?? createEmptyGeometryResolution(collectCandidates);
    }

    function findPageContainerFromClientPoint(clientX: number, clientY: number) {
        return resolvePageContainerByGeometry(clientX, clientY).pageContainer;
    }

    function resolvePageContainerFromTarget(targetElement?: HTMLElement | null) {
        const container = viewerContainer.value;
        if (!container || !targetElement) {
            return null;
        }
        const pageContainer = targetElement.closest<HTMLElement>('.page_container');
        if (!pageContainer) {
            return null;
        }
        if (!container.contains(pageContainer)) {
            const targetPageNumber = parsePageNumberFromContainer(pageContainer);
            if (!targetPageNumber) {
                return null;
            }
            const matchingPage = Array.from(container.querySelectorAll<HTMLElement>('.page_container'))
                .find(page => parsePageNumberFromContainer(page) === targetPageNumber)
                ?? null;
            return matchingPage;
        }
        return pageContainer;
    }

    function resolvePageContainerFromDocumentPoint(clientX: number, clientY: number) {
        const container = viewerContainer.value;
        if (!container || typeof document === 'undefined') {
            return {
                pointElement: null,
                pageContainer: null,
            };
        }
        const pointElement = document.elementFromPoint(clientX, clientY);
        if (!(pointElement instanceof HTMLElement)) {
            return {
                pointElement: null,
                pageContainer: null,
            };
        }
        const pageContainer = pointElement.closest<HTMLElement>('.page_container');
        if (!pageContainer || !container.contains(pageContainer)) {
            return {
                pointElement,
                pageContainer: null,
            };
        }
        return {
            pointElement,
            pageContainer,
        };
    }

    function logPagePointConflict(
        diagnostics: INotePlacementDiagnosticsContext,
        targetElement: HTMLElement | null,
        pointElement: HTMLElement | null,
        geometryResolution: IGeometryResolution,
        selection: IPagePointResolutionSelection,
        pageNumbers: IPagePointPageNumbers,
    ) {
        const viewer = viewerContainer.value;
        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Quick-note page target conflict detected', {
            attemptId: diagnostics.attemptId ?? null,
            source: diagnostics.source ?? null,
            selectedSource: selection.selectedSource,
            byTargetPage: pageNumbers.byTargetPage,
            byElementFromPointPage: pageNumbers.byElementFromPointPage,
            byGeometryPage: pageNumbers.byGeometryPage,
            targetConflictsWithElementPoint: selection.targetConflictsWithElementPoint,
            targetConflictsWithGeometry: selection.targetConflictsWithGeometry,
            clickTarget: summarizeElementForLog(targetElement),
            pointElement: summarizeElementForLog(pointElement),
            renderedPageCandidates: geometryResolution.candidates,
            visiblePageWindow: summarizeVisiblePageWindowForLog(),
            viewerScrollTop: viewer?.scrollTop ?? null,
            viewerScrollLeft: viewer?.scrollLeft ?? null,
            clickMeta: diagnostics.clickMeta ?? null,
        });
    }

    function logPagePointResolutionFailure(
        diagnostics: INotePlacementDiagnosticsContext,
        clientX: number,
        clientY: number,
        targetElement: HTMLElement | null,
        pointElement: HTMLElement | null,
        geometryResolution: IGeometryResolution,
        selection: IPagePointResolutionSelection,
        pageNumbers: IPagePointPageNumbers,
    ) {
        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Failed to resolve quick-note page container', {
            attemptId: diagnostics.attemptId ?? null,
            source: diagnostics.source ?? null,
            clientX: roundForLog(clientX),
            clientY: roundForLog(clientY),
            currentPage: currentPage.value,
            byTargetPage: pageNumbers.byTargetPage,
            byElementFromPointPage: pageNumbers.byElementFromPointPage,
            byGeometryPage: pageNumbers.byGeometryPage,
            selectedSource: selection.selectedSource,
            clickTarget: summarizeElementForLog(targetElement),
            pointElement: summarizeElementForLog(pointElement),
            renderedPageCandidates: geometryResolution.candidates,
            visiblePageWindow: summarizeVisiblePageWindowForLog(),
            clickMeta: diagnostics.clickMeta ?? null,
        });
    }

    function resolvePagePointTarget(
        clientX: number,
        clientY: number,
        targetElement?: HTMLElement | null,
        diagnostics?: INotePlacementDiagnosticsContext,
    ): IPagePointTarget | null {
        const targetPageContainer = resolvePageContainerFromTarget(targetElement);
        const documentPointResolution = resolvePageContainerFromDocumentPoint(clientX, clientY);
        const geometryResolution = resolvePageContainerByGeometry(clientX, clientY, {collectCandidates: Boolean(diagnostics)});
        const pageNumbers: IPagePointPageNumbers = {
            byTargetPage: parsePageNumberFromContainer(targetPageContainer),
            byElementFromPointPage: parsePageNumberFromContainer(documentPointResolution.pageContainer),
            byGeometryPage: parsePageNumberFromContainer(geometryResolution.pageContainer),
        };

        const selection = selectPagePointResolution({
            targetPageContainer,
            documentPointContainer: documentPointResolution.pageContainer,
            geometryResolution,
            ...pageNumbers,
        });

        if (diagnostics && selection.hasTargetConflict) {
            logPagePointConflict(
                diagnostics,
                targetElement ?? null,
                documentPointResolution.pointElement,
                geometryResolution,
                selection,
                pageNumbers,
            );
        }

        if (!selection.pageContainer) {
            if (diagnostics) {
                logPagePointResolutionFailure(
                    diagnostics,
                    clientX,
                    clientY,
                    targetElement ?? null,
                    documentPointResolution.pointElement,
                    geometryResolution,
                    selection,
                    pageNumbers,
                );
            }
            return null;
        }

        return buildPagePointTargetFromContainer(
            selection.pageContainer,
            clientX,
            clientY,
            selection.selectedSource,
            currentPage.value,
            diagnostics,
        );
    }

    return {
        resolvePagePointTarget,
        findPageContainerFromClientPoint,
    };
}
