import type { IScrollSnapshot } from '@app/types/pdf';
import { restoreScrollFromSnapshot } from '@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/restoreScrollFromSnapshot';
import { getMostVisiblePageFromDom } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getMostVisiblePageFromDom';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getRoundedScrollPosition } from '@app/modules/pdf-viewer/engine/pdf-rerender-restoration/getRoundedScrollPosition';
import type {
    IRerenderRestorationContext,
    IRerenderRestorationLoggerOptions,
    IRoundedScrollPosition,
    TRerenderRestoreMode,
} from '@app/modules/pdf-viewer/engine/pdf-rerender-restoration/pdfRerenderRestorationTypes';

function getNullableDelta(before: number | null, after: number | null) {
    return before !== null && after !== null
        ? after - before
        : null;
}

export function createPdfRerenderRestorationLogger(options: IRerenderRestorationLoggerOptions) {
    function logRerenderSnapshotCapture(
        version: number,
        preserveExistingPages: boolean,
        anchorSnapshot: IScrollSnapshot | null,
        snapshot: IScrollSnapshot | null,
        containerAtCapture: HTMLElement | null,
    ) {
        if (snapshot) {
            BrowserLogger.diagnosticThrottled('pdf-nav', 'rerender-snapshot-captured', options.throttleMs, `[re-render-snapshot] captured version=${version}`, {
                version,
                preserveExistingPages,
                hasAnchorSnapshotOverride: Boolean(anchorSnapshot),
                currentPage: options.currentPage.value,
                numPages: options.numPages.value,
                snapshot,
                scrollTop: containerAtCapture ? Math.round(containerAtCapture.scrollTop) : null,
                clientHeight: containerAtCapture ? Math.round(containerAtCapture.clientHeight) : null,
                mostVisiblePage: containerAtCapture
                    ? getMostVisiblePageFromDom(containerAtCapture, options.numPages.value)
                    : null,
            });
            return;
        }

        BrowserLogger.diagnosticThrottled('pdf-nav', 'rerender-snapshot-missing', options.throttleMs, `[re-render-snapshot] missing version=${version}`, {
            version,
            preserveExistingPages,
            hasAnchorSnapshotOverride: Boolean(anchorSnapshot),
            currentPage: options.currentPage.value,
            numPages: options.numPages.value,
            hasContainer: Boolean(containerAtCapture),
        });
    }

    function logRerenderZoomRestore(
        mode: TRerenderRestoreMode,
        rerenderSource: string,
        version: number,
        beforeScroll: IRoundedScrollPosition,
        afterScroll: IRoundedScrollPosition,
        disableOptions: {
            disableHorizontalAnchorRestore: boolean;
            disableVerticalAnchorRestore: boolean;
            disablePageAnchorRestore: boolean;
        },
        snapshotToRestore: IScrollSnapshot | null,
    ) {
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', `rerender-restore-${mode}`, options.throttleMs, `[rerender-restore] ${mode} source=${rerenderSource} version=${version}`, {
            rerenderSource,
            version,
            beforeScrollTop: beforeScroll.scrollTop,
            afterScrollTop: afterScroll.scrollTop,
            deltaScrollTop: getNullableDelta(beforeScroll.scrollTop, afterScroll.scrollTop),
            beforeScrollLeft: beforeScroll.scrollLeft,
            afterScrollLeft: afterScroll.scrollLeft,
            deltaScrollLeft: getNullableDelta(beforeScroll.scrollLeft, afterScroll.scrollLeft),
            ...disableOptions,
            snapshot: snapshotToRestore,
        });
    }

    function logRerenderNavRestore(
        mode: TRerenderRestoreMode,
        version: number,
        preserveExistingPages: boolean,
        anchorSnapshot: IScrollSnapshot | null,
        snapshotToRestore: IScrollSnapshot | null,
        containerAfterRestore: HTMLElement | null,
    ) {
        BrowserLogger.diagnosticThrottled('pdf-nav', mode === 'preserve' ? 'rerender-snapshot-restored-preserve' : 'rerender-snapshot-restored', options.throttleMs, `[re-render-snapshot] restored${mode === 'preserve' ? '-preserve' : ''} version=${version}`, {
            version,
            ...(mode === 'preserve' ? { preserveExistingPages } : {}),
            hasAnchorSnapshotOverride: Boolean(anchorSnapshot),
            currentPage: options.currentPage.value,
            numPages: options.numPages.value,
            snapshot: snapshotToRestore,
            scrollTop: containerAfterRestore ? Math.round(containerAfterRestore.scrollTop) : null,
            clientHeight: containerAfterRestore
                ? Math.round(containerAfterRestore.clientHeight)
                : null,
            mostVisiblePage: containerAfterRestore
                ? getMostVisiblePageFromDom(containerAfterRestore, options.numPages.value)
                : null,
        });
    }

    function restoreScrollAndLog(
        mode: TRerenderRestoreMode,
        context: IRerenderRestorationContext,
    ) {
        const containerBeforeRestore = options.container.value;
        const beforeScroll = getRoundedScrollPosition(containerBeforeRestore);
        const isZoomChangeRestore =
            context.rerenderSource === 'zoom-change'
            || context.rerenderSource === 'zoom-gesture-change';
        restoreScrollFromSnapshot(options.container.value, context.snapshotToRestore, {
            restoreHorizontal: !context.disableHorizontalAnchorRestore,
            restoreVertical: !context.disableVerticalAnchorRestore,
            preferPageAnchor: !context.disablePageAnchorRestore,
            allowVerticalRatioFallback: !isZoomChangeRestore,
        });
        const containerAfterRestore = options.container.value;
        const afterScroll = getRoundedScrollPosition(containerAfterRestore);

        logRerenderZoomRestore(
            mode,
            context.rerenderSource,
            context.version,
            beforeScroll,
            afterScroll,
            {
                disableHorizontalAnchorRestore: context.disableHorizontalAnchorRestore,
                disableVerticalAnchorRestore: context.disableVerticalAnchorRestore,
                disablePageAnchorRestore: context.disablePageAnchorRestore,
            },
            context.snapshotToRestore,
        );
        logRerenderNavRestore(
            mode,
            context.version,
            context.preserveExistingPages,
            context.anchorSnapshot,
            context.snapshotToRestore,
            containerAfterRestore,
        );
    }

    return {
        logRerenderSnapshotCapture,
        logRerenderZoomRestore,
        logRerenderNavRestore,
        restoreScrollAndLog,
    };
}
