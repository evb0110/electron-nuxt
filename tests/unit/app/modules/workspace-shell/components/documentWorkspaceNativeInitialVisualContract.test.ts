import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('DocumentWorkspace native initial visual contract', () => {
    it('wires native PDF and DjVu into viewer-owned initial visual readiness without shell placeholder suppression', async () => {
        const workspaceSource = await readFile(
            join(process.cwd(), 'app/modules/workspace-shell/components/DocumentWorkspace.vue'),
            'utf8',
        );
        const viewerHostSource = await readFile(
            join(process.cwd(), 'app/modules/workspace-shell/components/layout/WorkspaceViewerHost.vue'),
            'utf8',
        );
        const transitionSkeletonSource = await readFile(
            join(process.cwd(), 'app/modules/workspace-shell/components/WorkspaceDocumentTransitionSkeleton.vue'),
            'utf8',
        );

        const dynamicViewerBlock = workspaceSource.slice(
            workspaceSource.indexOf('<component'),
            workspaceSource.indexOf('/>', workspaceSource.indexOf('<component')),
        );

        expect(workspaceSource).not.toContain('<PdfViewer');
        expect(workspaceSource).not.toContain('<NativePdfViewer');
        expect(workspaceSource).not.toContain('<DjvuViewer');
        expect(dynamicViewerBlock).toContain(':is="activeViewerComponent"');
        expect(dynamicViewerBlock).toContain('v-bind="activeViewerProps"');
        expect(dynamicViewerBlock).toContain('v-on="activeViewerListeners"');
        expect(dynamicViewerBlock).toContain(':ref="bindActiveViewerRef"');
        expect(workspaceSource).not.toContain('suppress-loading-overlay');
        expect(workspaceSource).not.toContain('suppress-initial-placeholder');
        expect(workspaceSource).toContain('onInitialVisualPending: handleDocumentInitialVisualPending');
        expect(workspaceSource).toContain('onInitialVisualReady: handleDocumentInitialVisualReady');

        expect(workspaceSource).not.toContain(':show-opening-surface');
        expect(workspaceSource).not.toContain('showOpeningSurface');
        expect(workspaceSource).toContain(':show-transition-overlay="showWorkspaceTransitionSkeleton"');
        expect(workspaceSource).toContain('useDocumentTransitionSkeletonLease');
        expect(workspaceSource).toContain('pendingDocumentStatusPath');
        expect(workspaceSource).toContain('showPendingViewerMountSkeleton');
        expect(workspaceSource).toContain('activeViewerMounted');
        expect(workspaceSource).toContain('hasPendingViewerSource');
        expect(workspaceSource).toContain('Boolean(activeViewerAdapter.value)');
        expect(workspaceSource).toContain('Boolean(pdfSrc.value)');
        expect(workspaceSource).toContain('Boolean(nativePdfSourcePath.value)');
        expect(workspaceSource).toContain('Boolean(djvuSourcePath.value)');
        expect(workspaceSource).toContain('&& hasPendingViewerSource.value');
        expect(workspaceSource).toContain('isDocumentOpenPlaceholderVisible.value');
        expect(workspaceSource).toContain('|| showPendingViewerMountSkeleton.value');
        expect(workspaceSource).toContain('showPendingDocumentOpenSkeleton');
        expect(workspaceSource).toContain('<WorkspaceDocumentTransitionSkeleton v-if="showWorkspaceTransitionSkeleton" />');
        expect(viewerHostSource).not.toContain('WorkspaceDocumentOpeningSurface');
        expect(viewerHostSource).not.toContain('showOpeningSurface');
        expect(viewerHostSource).not.toContain('document-workspace__opening-placeholder');
        expect(viewerHostSource).toContain('<template v-if="hasDocument">');
        expect(viewerHostSource).toContain('v-if="showTransitionOverlay"');
        expect(viewerHostSource).toContain('workspace-viewer-host__transition-overlay');
        expect(viewerHostSource).toContain('z-index: var(--app-workspace-transition-overlay-z-index)');
        expect(viewerHostSource).not.toContain('z-index: 10');
        expect(transitionSkeletonSource).toContain('PdfPageSkeleton');
        expect(transitionSkeletonSource).not.toContain('PdfInitialSurfacePlaceholder');
    });

    it('reserves the DjVu banner row for the whole pending DjVu open window', async () => {
        const [
            workspaceSource,
            alertsSource,
            fallbackSource,
        ] = await Promise.all([
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/DocumentWorkspace.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/WorkspaceDocumentAlerts.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/WorkspaceHostDocumentOpenFallback.vue'),
                'utf8',
            ),
        ]);

        expect(workspaceSource).toContain('pendingDjvuDocumentOpen');
        expect(workspaceSource).toContain(':djvu-pending-open="pendingDjvuDocumentOpen"');
        expect(workspaceSource).toContain(':djvu-opening="djvuBannerOpening"');
        expect(workspaceSource).toContain('const hasDjvuBannerOpeningContext = computed');
        expect(workspaceSource).toContain('const djvuBannerOpening = computed');
        expect(workspaceSource).toContain('showWorkspaceTransitionSkeleton.value');
        expect(workspaceSource).toContain('!initialDocumentVisualReady.value');
        expect(workspaceSource).toContain('getDocumentKindFromPath');
        expect(alertsSource).toContain('showDjvuConversionUi || djvuPendingOpen || djvuOpening');
        expect(alertsSource).toContain('djvuOpening || djvuShowBanner || djvuPendingOpen');
        expect(alertsSource).toContain(':is-opening="djvuOpening || djvuPendingOpen"');
        expect(alertsSource).not.toContain('defineAsyncComponent');
        expect(alertsSource).toContain('from \'@app/modules/djvu-viewer/public/component-exports/djvuBanner\'');
        expect(fallbackSource).toContain('DjvuBanner');
        expect(fallbackSource).toContain('is-opening');
        expect(fallbackSource).toContain('isPendingDjvuPath');
        expect(fallbackSource).toContain('getDocumentKindFromPath');
        expect(fallbackSource).toContain('flex-direction: column');
    });

    it('keeps the deferred workspace host from painting a detached opening surface', async () => {
        const [
            hostSource,
            fallbackSource,
        ] = await Promise.all([
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/WorkspaceHostDocumentOpenFallback.vue'),
                'utf8',
            ),
        ]);

        expect(hostSource).not.toContain('openingDocumentSkeleton');
        expect(hostSource).not.toContain('PdfPageSkeleton');
        expect(hostSource).not.toContain('WorkspaceDocumentOpeningSurface');
        expect(hostSource).not.toContain('layer="host"');
        expect(hostSource).not.toContain('workspace-host__opening-surface');
        expect(hostSource).not.toContain('isDocumentOpeningSurfaceVisible');
        expect(hostSource).toContain(':pending-document-path="pendingDocumentPath"');
        expect(hostSource).toContain('const pendingDocumentPath = computed');
        expect(hostSource).toContain('WorkspaceHostDocumentOpenFallback');
        expect(hostSource).toContain('showHostDocumentOpenSkeleton');
        expect(hostSource).toContain('requestWorkspaceMount(`document-open:${intent.action}`)');
        expect(hostSource).toContain('requestWorkspaceMount(`ensureWorkspaceLoaded:${reason}`)');
        expect(fallbackSource).toContain('WorkspaceDocumentTransitionSkeleton');
        expect(fallbackSource).toContain('PdfStatusBar');
        expect(fallbackSource).toContain('usePageStatusBar');
        expect(fallbackSource).not.toContain('AppSpinner');
        expect(fallbackSource).not.toContain('PdfInitialSurfacePlaceholder');
    });
});
