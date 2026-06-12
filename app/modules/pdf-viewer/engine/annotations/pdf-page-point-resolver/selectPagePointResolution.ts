

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
