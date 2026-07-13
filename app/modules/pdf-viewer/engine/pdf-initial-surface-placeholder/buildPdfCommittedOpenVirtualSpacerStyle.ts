import type { TPdfViewMode } from '@app/types/pdfContracts';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';
import { getTrailingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getTrailingSpacerHeightForPage';
import {
    hasCommittedDocumentOpeningLayout,
    isDocumentOpenEmptySurfaceTransition,
    type IDocumentOpenSurfaceSnapshot,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

function readPositivePixels(value: string | undefined) {
    if (!value?.endsWith('px')) {
        return null;
    }
    const number = Number.parseFloat(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

export function buildPdfCommittedOpenVirtualSpacerStyle(input: {
    snapshot: IDocumentOpenSurfaceSnapshot;
    continuousScroll: boolean;
    viewMode: TPdfViewMode;
    gap: number;
    lastMountedPage: number;
}) {
    if (!input.continuousScroll || !hasCommittedDocumentOpeningLayout(input.snapshot)) {
        return null;
    }

    const geometry = input.snapshot.openingPageGeometry;
    const frame = input.snapshot.openingPageFrame;
    if (!geometry || !frame || input.lastMountedPage >= geometry.pageCount) {
        return null;
    }

    const width = readPositivePixels(frame.style.width);
    const height = readPositivePixels(frame.style.height);
    if (width === null || height === null) {
        return null;
    }

    const pageMetrics = Array.from({ length: geometry.pageCount }, () => ({
        width,
        height,
    }));
    const layout = buildPageLayoutMetrics({
        pageMetrics,
        totalPages: geometry.pageCount,
        viewMode: input.viewMode,
        scale: 1,
        gap: input.gap,
        paddingTop: input.gap,
        paddingBottom: input.gap,
        fallbackWidth: width,
        fallbackHeight: height,
    });
    if (!layout) {
        return null;
    }

    const spacerHeight = getTrailingSpacerHeightForPage(layout, input.lastMountedPage);
    if (spacerHeight <= 0) {
        return null;
    }
    const value = `${String(spacerHeight)}px`;
    return {
        height: value,
        minHeight: value,
        flexBasis: value,
    };
}

export function resolvePdfCommittedOpenVirtualExtentMinimumScrollHeight(input: {
    snapshot: IDocumentOpenSurfaceSnapshot;
    continuousScroll: boolean;
    viewMode: TPdfViewMode;
    gap: number;
}) {
    if (!input.continuousScroll) {
        return 0;
    }
    if (
        isDocumentOpenEmptySurfaceTransition(input.snapshot)
        && input.snapshot.openingPageFrame !== null
        && input.snapshot.openingPageGeometry === null
    ) {
        return null;
    }
    if (!hasCommittedDocumentOpeningLayout(input.snapshot)) {
        return 0;
    }
    const geometry = input.snapshot.openingPageGeometry;
    if (!geometry || geometry.pageCount <= geometry.pageNumber) {
        return 0;
    }
    const style = buildPdfCommittedOpenVirtualSpacerStyle({
        ...input,
        lastMountedPage: geometry.pageNumber,
    });
    return style ? readPositivePixels(style.height) : null;
}
