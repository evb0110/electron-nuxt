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
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const container = host?.querySelector<HTMLElement>('.native-pdf-viewer-container') ?? null;
        const renderedImages = Array.from(container?.querySelectorAll<HTMLImageElement>('.native-pdf-page-shell img') ?? [])
            .filter(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
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
            hostDocumentOpenFallbackCount: host?.querySelectorAll('.workspace-host-document-open-fallback').length ?? 0,
            nativeViewerVisible: isElementVisible(container),
            placeholderCount: container?.querySelectorAll('.native-pdf-page-placeholder').length ?? 0,
            renderedImages: renderedImages.length,
            renderedImageSizes: renderedImages.slice(0, 4).map(image => ({
                height: image.naturalHeight,
                width: image.naturalWidth,
            })),
            shellCount: container?.querySelectorAll('.native-pdf-page-shell').length ?? 0,
            skeletonCount: host?.querySelectorAll('.native-pdf-page-shell .pdf-page-skeleton').length ?? 0,
            standardPdfViewerVisible: isElementVisible(standardPdfViewer),
            transitionSurfaceCount: host?.querySelectorAll('.workspace-document-transition-skeleton').length ?? 0,
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
        const elementOwnsViewportPoint = (owner: HTMLElement | null, rect: ReturnType<typeof toRect>) => {
            if (!owner || !rect) {
                return false;
            }

            const visibleLeft = Math.max(0, rect.left);
            const visibleTop = Math.max(0, rect.top);
            const visibleRight = Math.min(window.innerWidth, rect.left + rect.width);
            const visibleBottom = Math.min(window.innerHeight, rect.top + rect.height);
            if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
                return false;
            }

            const x = Math.min(window.innerWidth - 1, Math.max(0, visibleLeft + (visibleRight - visibleLeft) / 2));
            const y = Math.min(window.innerHeight - 1, Math.max(0, visibleTop + (visibleBottom - visibleTop) / 2));
            const topElement = document.elementFromPoint(x, y);
            return Boolean(topElement && owner.contains(topElement));
        };

        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isElementVisible);
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const container = host?.querySelector<HTMLElement>('.native-pdf-viewer-container') ?? null;
        const hostDocumentOpenFallback = host?.querySelector<HTMLElement>('.workspace-host-document-open-fallback') ?? null;
        const transitionSurface = host?.querySelector<HTMLElement>('.workspace-document-transition-skeleton') ?? null;
        const transitionPageShell = transitionSurface?.querySelector<HTMLElement>('.workspace-document-transition-skeleton__page-shell') ?? null;
        const emptyState = host?.querySelector<HTMLElement>('.empty-state') ?? null;
        const statusBar = document.querySelector<HTMLElement>('.editor-pane.is-active .status-bar')
            ?? document.querySelector<HTMLElement>('.status-bar');
        const statusPath = statusBar?.querySelector<HTMLElement>('.status-bar-path') ?? null;
        const statusMetricTexts = Array.from(statusBar?.querySelectorAll<HTMLElement>('.status-bar-item') ?? [])
            .map(element => (element.textContent ?? '').trim())
            .filter(Boolean);
        const pageSkeletons = Array.from(host?.querySelectorAll<HTMLElement>('.native-pdf-page-shell .pdf-page-skeleton') ?? []);
        const transitionSkeletons = Array.from(host?.querySelectorAll<HTMLElement>('.workspace-document-transition-skeleton .pdf-page-skeleton') ?? []);
        const pageShells = Array.from(host?.querySelectorAll<HTMLElement>('.native-pdf-page-shell') ?? []);
        const firstVisiblePageShell = pageShells.find(isElementVisible) ?? null;
        const renderedImages = Array.from(container?.querySelectorAll<HTMLImageElement>('.native-pdf-page-shell img') ?? [])
            .filter(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
        const transitionPageShellRect = toRect(transitionPageShell);
        const firstVisiblePageShellRect = toRect(firstVisiblePageShell);
        const transitionSkeletonIsTopSurface = isElementVisible(transitionPageShell)
            && elementOwnsViewportPoint(transitionPageShell, transitionPageShellRect);
        const nativeSkeletonIsTopSurface = firstVisiblePageShell
            ? pageSkeletons.some(skeleton => firstVisiblePageShell.contains(skeleton))
                && isElementVisible(firstVisiblePageShell)
                && elementOwnsViewportPoint(firstVisiblePageShell, firstVisiblePageShellRect)
            : false;
        const topPendingSurface = transitionSkeletonIsTopSurface
            ? 'transition'
            : (nativeSkeletonIsTopSurface ? 'native' : 'none');

        return {
            emptyStateVisible: isElementVisible(emptyState),
            emptyStateText: (emptyState?.textContent ?? '').trim(),
            hostDocumentOpenFallbackVisible: isElementVisible(hostDocumentOpenFallback),
            hostDocumentOpenFallbackRect: toRect(hostDocumentOpenFallback),
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
            shellCount: container?.querySelectorAll('.native-pdf-page-shell').length ?? 0,
            statusBarVisible: isElementVisible(statusBar),
            statusFileName: (statusPath?.textContent ?? '').trim(),
            statusMetricTexts,
            viewerRect: toRect(container),
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
