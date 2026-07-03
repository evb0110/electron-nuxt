import type { Ref } from 'vue';
import { tracePdfAnnotationSaveDom } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveDom';
import { tracePdfAnnotationSaveEvent } from '@app/modules/pdf-viewer/engine/pdf-annotation-save-trace/tracePdfAnnotationSaveEvent';
import { hasPdfPageAnnotationVisualContentForSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/hasPdfPageAnnotationVisualContentForSnapshotRelease';
import type { TPdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotRelease';
import { preservePdfPageAnnotationVisualSnapshot } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/preservePdfPageAnnotationVisualSnapshot';
import { schedulePdfLayerVisualSnapshotRelease } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/schedulePdfLayerVisualSnapshotRelease';
import type { IScrollSnapshot } from '@app/types/pdfUi';

const PRESERVED_VISUAL_SNAPSHOT_CAPTURE_MAX_DELAY_MS = 15_000;
const PRESERVED_VISUAL_SNAPSHOT_RELEASE_MAX_DELAY_MS = 2_500;

export interface IPreservedScrollPosition {
    left: number;
    top: number;
}

export interface IPreservedVisibleContentRequest {
    scrollSnapshot?: IScrollSnapshot | null;
    pageToRestore?: number | null;
}

export interface IPreservedVisibleContentState {
    scrollPosition: IPreservedScrollPosition | null;
    pageToRestore: number | null;
    visualSnapshotRelease: TPdfLayerVisualSnapshotRelease | null;
}

interface IPreservedVisibleContentReleasePlan {
    preservedVisibleContent: IPreservedVisibleContentState | null;
    resolvedPageToRestore: number;
}

interface IUsePdfViewerPreservedVisibleContentOptions {
    viewerContainer: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
}

function normalizePreservedPageNumber(value: number | null | undefined) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(1, Math.floor(value))
        : null;
}

function asHtmlElement(value: Element | null | undefined) {
    if (!value) {
        return null;
    }
    if (typeof HTMLElement === 'undefined') {
        return value as HTMLElement;
    }
    return value instanceof HTMLElement ? value : null;
}

export const usePdfViewerPreservedVisibleContent = (options: IUsePdfViewerPreservedVisibleContentOptions) => {
    function findPreservedPageContainer(pageNumber: number | null | undefined) {
        const container = options.viewerContainer.value;
        const normalizedPage = normalizePreservedPageNumber(pageNumber) ?? options.currentPage.value;
        return asHtmlElement(
            container?.querySelector(`.page_container[data-page="${normalizedPage}"]`),
        );
    }

    function createTracedPreservedVisualSnapshotRelease(
        release: TPdfLayerVisualSnapshotRelease | null,
        pageNumber: number | null,
        pageContainer: HTMLElement | null,
    ) {
        if (!release) {
            return null;
        }

        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            tracePdfAnnotationSaveDom(
                'document-lifecycle:preserved-visual-snapshot:release',
                pageContainer,
                { pageNumber },
            );
            release();
        };
    }

    function capturePreservedVisualSnapshot(pageNumber: number | null) {
        const snapshotPage = normalizePreservedPageNumber(pageNumber) ?? options.currentPage.value;
        const pageContainer = findPreservedPageContainer(snapshotPage);
        const release = createTracedPreservedVisualSnapshotRelease(
            preservePdfPageAnnotationVisualSnapshot(pageContainer, null),
            snapshotPage,
            pageContainer,
        );
        tracePdfAnnotationSaveDom(
            'document-lifecycle:preserved-visual-snapshot:capture',
            pageContainer,
            {
                hasSnapshot: Boolean(release),
                pageNumber: snapshotPage,
            },
        );
        schedulePdfLayerVisualSnapshotRelease(release, {
            maxDelayMs: PRESERVED_VISUAL_SNAPSHOT_CAPTURE_MAX_DELAY_MS,
            minFrames: 1,
            waitFor: () => false,
        });
        return release;
    }

    function releasePreservedVisualSnapshotNow(
        state: IPreservedVisibleContentState | null,
        reason: string,
    ) {
        if (!state?.visualSnapshotRelease) {
            return;
        }
        tracePdfAnnotationSaveEvent(
            'document-lifecycle:preserved-visual-snapshot:release-now',
            {
                pageNumber: state.pageToRestore,
                reason,
            },
        );
        state.visualSnapshotRelease();
        state.visualSnapshotRelease = null;
    }

    function schedulePreservedVisualSnapshotRelease(
        plan: IPreservedVisibleContentReleasePlan,
        reason: string,
    ) {
        const state = plan.preservedVisibleContent;
        if (!state?.visualSnapshotRelease) {
            return;
        }

        const release = state.visualSnapshotRelease;
        state.visualSnapshotRelease = null;
        const pageNumber = plan.resolvedPageToRestore;
        tracePdfAnnotationSaveDom(
            'document-lifecycle:preserved-visual-snapshot:schedule-release',
            findPreservedPageContainer(pageNumber),
            {
                pageNumber,
                reason,
            },
        );
        schedulePdfLayerVisualSnapshotRelease(release, {
            maxDelayMs: PRESERVED_VISUAL_SNAPSHOT_RELEASE_MAX_DELAY_MS,
            minFrames: 1,
            waitFor: () => hasPdfPageAnnotationVisualContentForSnapshotRelease(
                findPreservedPageContainer(pageNumber),
            ),
        });
    }

    function capturePreservedVisibleContentState(
        request?: IPreservedVisibleContentRequest,
    ): IPreservedVisibleContentState {
        const container = options.viewerContainer.value;
        const requestPage = normalizePreservedPageNumber(request?.pageToRestore);
        const snapshotPage = normalizePreservedPageNumber(request?.scrollSnapshot?.anchorPage);
        const pageToRestore = requestPage ?? snapshotPage ?? options.currentPage.value;
        return {
            scrollPosition: container
                ? {
                    left: container.scrollLeft,
                    top: container.scrollTop,
                }
                : null,
            pageToRestore,
            visualSnapshotRelease: capturePreservedVisualSnapshot(pageToRestore),
        };
    }

    return {
        capturePreservedVisibleContentState,
        releasePreservedVisualSnapshotNow,
        schedulePreservedVisualSnapshotRelease,
    };
};
