import type { Page } from 'puppeteer-core';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import { getWorkspaceToolbarSnapshot } from '@tests/e2e/electron/helpers/workspaceExpose';

export async function readNativePdfPreviewState(page: Page) {
    const domState = await evaluateInPage(page, () => {
        const isElementVisible = (element: HTMLElement | null) => {
            if (!element?.isConnected) {
                return false;
            }

            let current: HTMLElement | null = element;
            while (current) {
                const style = window.getComputedStyle(current);
                if (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') === 0
                ) {
                    return false;
                }
                current = current.parentElement;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };

        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isElementVisible);
        const activeHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const container = host?.querySelector<HTMLElement>('.native-pdf-viewer-container') ?? null;
        const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
        const viewportHost = chassis?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
        const pageImages = Array.from(container?.querySelectorAll<HTMLImageElement>('.native-pdf-page-shell img') ?? []);
        const renderedImages = pageImages
            .filter(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
        const visibleRenderedImages = renderedImages.filter(isElementVisible);
        const standardPdfViewer = host?.querySelector<HTMLElement>('#pdf-viewer') ?? null;
        const visibleErrors = Array.from(document.querySelectorAll<HTMLElement>([
            '[data-testid="native-pdf-viewer-error"]',
            '[data-testid="workspace-document-pdf-error"]',
            '[data-testid="workspace-document-djvu-error"]',
            '.native-pdf-page-placeholder',
        ].join(',')))
            .filter(isElementVisible)
            .map(element => (element.textContent ?? '').trim())
            .filter(Boolean);
        const bodyText = document.body.textContent ?? '';
        const crashPatterns = [
            'Array buffer allocation failed',
            'No handler registered',
            'Failed to load PDF',
            'UnknownErrorException',
            'RangeError',
        ];

        return {
            crashText: crashPatterns.filter(pattern => bodyText.includes(pattern)).join('\n'),
            errorTexts: visibleErrors,
            openSurface: {
                hasRender: chassis?.dataset.openSurfaceHasRender === 'true',
                hasViewport: chassis?.dataset.openSurfaceHasViewport === 'true',
                phase: viewportHost?.dataset.openSurfacePhase ?? '',
                presentation: chassis?.dataset.openSurfacePresentation ?? '',
            },
            hostDocumentOpenFallbackCount: host?.querySelectorAll('.workspace-host-document-open-fallback').length ?? 0,
            nativeViewerVisible: isElementVisible(container),
            placeholderCount: container?.querySelectorAll('.native-pdf-page-placeholder').length ?? 0,
            renderedImages: renderedImages.length,
            visibleRenderedImages: visibleRenderedImages.length,
            pendingDecodedImages: pageImages.filter(image => (
                !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0
            )).length,
            renderedImageSizes: renderedImages.slice(0, 4).map(image => ({
                height: image.naturalHeight,
                requiredWidth: Math.ceil(image.getBoundingClientRect().width * Math.min(window.devicePixelRatio || 1, 2)),
                width: image.naturalWidth,
            })),
            imageCountPerShell: Array.from(container?.querySelectorAll<HTMLElement>('.native-pdf-page-shell') ?? [])
                .map(shell => shell.querySelectorAll('img').length),
            shellCount: container?.querySelectorAll('.native-pdf-page-shell').length ?? 0,
            skeletonCount: host?.querySelectorAll('.native-pdf-page-shell .document-page-skeleton').length ?? 0,
            standardPdfViewerVisible: isElementVisible(standardPdfViewer),
            transitionSurfaceCount: host?.querySelectorAll('.document-viewer-chassis__opening-page').length ?? 0,
        };
    });
    const toolbar = await getWorkspaceToolbarSnapshot(page);
    return {
        ...domState,
        toolbar,
    };
}
export async function readNativePdfPreviewLoadingState(page: Page) {
    const domState = await evaluateInPage(page, () => {
        const isElementVisible = (element: HTMLElement | null) => {
            if (!element?.isConnected) {
                return false;
            }

            let current: HTMLElement | null = element;
            while (current) {
                const style = window.getComputedStyle(current);
                if (
                    style.display === 'none'
                    || style.visibility === 'hidden'
                    || Number(style.opacity || '1') === 0
                ) {
                    return false;
                }
                current = current.parentElement;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        const toRect = (element: HTMLElement | null) => {
            if (!element) {
                return null;
            }
            const rect = element.getBoundingClientRect();
            return {
                height: rect.height,
                left: rect.left,
                top: rect.top,
                width: rect.width,
            };
        };
        const elementIntersectsCanonicalViewport = (
            element: HTMLElement | null,
            viewportElement: HTMLElement | null,
        ) => {
            if (!element || !viewportElement || !isElementVisible(element) || !isElementVisible(viewportElement)) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            const viewportRect = viewportElement.getBoundingClientRect();
            const left = Math.max(0, rect.left, viewportRect.left);
            const top = Math.max(0, rect.top, viewportRect.top);
            const right = Math.min(window.innerWidth, rect.right, viewportRect.right);
            const bottom = Math.min(window.innerHeight, rect.bottom, viewportRect.bottom);
            return right > left && bottom > top;
        };

        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isElementVisible);
        const activeHost = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const container = host?.querySelector<HTMLElement>('.native-pdf-viewer-container') ?? null;
        const chassis = host?.querySelector<HTMLElement>('.document-viewer-chassis') ?? null;
        const viewportHost = chassis?.querySelector<HTMLElement>('[data-open-surface-phase]') ?? null;
        const hostDocumentOpenFallback = host?.querySelector<HTMLElement>('.workspace-host-document-open-fallback') ?? null;
        const workspaceSurface = host?.querySelector<HTMLElement>('.workspace-viewer-host') ?? null;
        const transitionSurface = host?.querySelector<HTMLElement>('.document-viewer-chassis__opening-page') ?? null;
        const transitionPageShell = transitionSurface;
        const emptyState = host?.querySelector<HTMLElement>('.empty-state') ?? null;
        const statusBar = document.querySelector<HTMLElement>('.editor-pane.is-active .status-bar')
            ?? document.querySelector<HTMLElement>('.status-bar');
        const statusPath = statusBar?.querySelector<HTMLElement>('.status-bar-path') ?? null;
        const statusMetricTexts = Array.from(statusBar?.querySelectorAll<HTMLElement>('.status-bar-item') ?? [])
            .map(element => (element.textContent ?? '').trim())
            .filter(Boolean);
        const pageSkeletons = Array.from(host?.querySelectorAll<HTMLElement>('.native-pdf-page-shell .document-page-skeleton') ?? []);
        const transitionSkeletons = Array.from(host?.querySelectorAll<HTMLElement>('.document-viewer-chassis__opening-page .document-page-skeleton') ?? []);
        const pageShells = Array.from(host?.querySelectorAll<HTMLElement>('.native-pdf-page-shell') ?? []);
        const firstVisiblePageShell = pageShells.find(isElementVisible) ?? null;
        const pageImages = Array.from(container?.querySelectorAll<HTMLImageElement>('.native-pdf-page-shell img') ?? []);
        const renderedImages = pageImages
            .filter(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
        const visibleRenderedImages = renderedImages.filter(isElementVisible);
        const transitionPageShellRect = toRect(transitionPageShell);
        const openSurfacePhase = viewportHost?.dataset.openSurfacePhase ?? '';
        const openSurfacePresentation = chassis?.dataset.openSurfacePresentation ?? '';
        const openSurfaceClaimed = isElementVisible(chassis)
            && openSurfacePhase !== ''
            && openSurfacePhase !== 'idle'
            && (chassis?.dataset.openSurfaceDocumentId ?? '').length > 0;
        const transitionSkeletonIsTopSurface = openSurfaceClaimed
            && openSurfacePresentation === 'page-shell'
            && transitionSkeletons.some(isElementVisible)
            && elementIntersectsCanonicalViewport(transitionPageShell, viewportHost);
        const nativeSkeletonIsTopSurface = firstVisiblePageShell
            ? pageSkeletons.some(skeleton => firstVisiblePageShell.contains(skeleton))
                && openSurfaceClaimed
                && openSurfacePresentation !== 'page-shell'
                && elementIntersectsCanonicalViewport(firstVisiblePageShell, viewportHost)
            : false;
        const topPendingSurface = transitionSkeletonIsTopSurface
            ? 'transition'
            : (nativeSkeletonIsTopSurface ? 'native' : 'none');

        return {
            emptyStateVisible: isElementVisible(emptyState),
            emptyStateText: (emptyState?.textContent ?? '').trim(),
            hostDocumentOpenFallbackVisible: isElementVisible(hostDocumentOpenFallback),
            hostDocumentOpenFallbackRect: toRect(hostDocumentOpenFallback),
            openSurface: {
                claimed: openSurfaceClaimed,
                hasOpeningFrame: chassis?.dataset.openSurfaceHasOpeningFrame === 'true',
                hasOpeningGeometry: chassis?.dataset.openSurfaceHasOpeningGeometry === 'true',
                phase: openSurfacePhase,
                presentation: openSurfacePresentation,
            },
            transitionSurfaceVisible: isElementVisible(transitionSurface),
            transitionSurfaceRect: toRect(transitionSurface),
            transitionPageShellRect,
            topPendingSurface,
            nativeViewerVisible: isElementVisible(container),
            pageSkeletonCount: pageSkeletons.length,
            visiblePageSkeletonCount: pageSkeletons.filter(isElementVisible).length,
            visibleTransitionSkeletonCount: transitionSkeletons.filter(isElementVisible).length,
            pageShellRects: pageShells.filter(isElementVisible).slice(0, 4).map(toRect),
            renderedImages: renderedImages.length,
            visibleRenderedImages: visibleRenderedImages.length,
            pendingDecodedImages: pageImages.filter(image => (
                !image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0
            )).length,
            shellCount: container?.querySelectorAll('.native-pdf-page-shell').length ?? 0,
            statusBarVisible: isElementVisible(statusBar),
            statusFileName: (statusPath?.textContent ?? '').trim(),
            statusMetricTexts,
            viewerRect: toRect(container),
            viewportRect: toRect(viewportHost),
            workspaceSurfaceRect: toRect(workspaceSurface),
            viewport: {
                height: window.innerHeight,
                width: window.innerWidth,
            },
        };
    });
    const toolbar = await getWorkspaceToolbarSnapshot(page);
    return {
        ...domState,
        toolbar,
    };
}
