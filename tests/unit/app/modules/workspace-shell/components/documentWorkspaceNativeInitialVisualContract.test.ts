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
        const surfaceLifecycleSource = await readFile(
            join(process.cwd(), 'app/modules/workspace-shell/composables/useDocumentOpenSurfaceLifecycle.ts'),
            'utf8',
        );
        const presentationSource = await readFile(
            join(process.cwd(), 'app/modules/workspace-shell/composables/useDocumentWorkspaceViewerPresentation.ts'),
            'utf8',
        );
        const deferredHostSource = await readFile(
            join(process.cwd(), 'app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue'),
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
        expect(workspaceSource).toContain('useDocumentOpenSurfaceLifecycle');
        expect(workspaceSource).toContain('pendingDocumentStatusPath');
        expect(workspaceSource).toContain('useDocumentWorkspaceViewerPresentation');
        expect(presentationSource).toContain('options.isDocumentOpenPlaceholderVisible.value');
        expect(workspaceSource).not.toContain('WorkspaceDocumentTransitionSkeleton');
        expect(workspaceSource).toContain('const documentOpenSurface = injectDocumentOpenSurfaceSession();');
        expect(workspaceSource).toContain('DocumentWorkspace requires the host-owned document open surface session');
        expect(workspaceSource).not.toContain('injectDocumentOpenSurfaceSession() ?? createDocumentOpenSurfaceSession()');
        expect(workspaceSource).not.toContain('createDocumentOpenSurfaceSession');
        expect(deferredHostSource).toContain('provide(documentOpenSurfaceSessionKey, documentOpenSurface)');
        expect(deferredHostSource).toContain('suppress-empty-state');
        expect(deferredHostSource).not.toContain(':suppress-empty-state="isPlaceholderVisible"');
        expect(deferredHostSource).toContain('const canPremountActiveEmpty = ref(true)');
        expect(workspaceSource).toContain('activeViewerAdapter.value ?? getWorkspaceViewerAdapter(\'pdf\')');
        expect(workspaceSource).toContain('suppressEmptyStateProp || suppressEmptyStateForRestore || isDocumentOpenPlaceholderVisible');
        expect(viewerHostSource).not.toContain('WorkspaceDocumentOpeningSurface');
        expect(viewerHostSource).not.toContain('showOpeningSurface');
        expect(viewerHostSource).not.toContain('document-workspace__opening-placeholder');
        expect(workspaceSource).toContain(':keep-document-layout-mounted="suppressEmptyStateProp"');
        expect(viewerHostSource).toContain('v-show="documentLayoutVisible"');
        expect(viewerHostSource).toContain('shouldKeepWorkspaceDocumentLayoutVisible');
        expect(viewerHostSource).toContain(':aria-hidden="!hasDocument ? \'true\' : undefined"');
        expect(workspaceSource).toContain('v-if="mountedViewerAdapter"');
        expect(viewerHostSource).not.toContain('retained-empty');
        expect(viewerHostSource).not.toContain('z-index: 10');
        expect(viewerHostSource).not.toContain('slot name="transition"');
        expect(surfaceLifecycleSource).not.toContain('retainEmptySurface');

        const chassisSource = await readFile(
            join(process.cwd(), 'app/modules/workspace-shell/components/DocumentViewerChassis.vue'),
            'utf8',
        );
        expect(chassisSource).toContain('DocumentViewerChassis requires the host-owned document open surface session');
        expect(chassisSource).toContain('documentOpenSurface,');
        expect(chassisSource).not.toContain('injectDocumentOpenSurfaceSession() ?? undefined');
        expect(chassisSource).not.toContain('createDocumentOpenSurfaceSession');
    });

    it('reserves the DjVu banner row for the whole pending DjVu open window', async () => {
        const [
            workspaceSource,
            alertsSource,
            presentationSource,
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
                join(process.cwd(), 'app/modules/workspace-shell/composables/useDocumentWorkspaceViewerPresentation.ts'),
                'utf8',
            ),
        ]);

        expect(workspaceSource).toContain('pendingDjvuDocumentOpen');
        expect(workspaceSource).toContain(':djvu-pending-open="pendingDjvuDocumentOpen"');
        expect(workspaceSource).toContain(':djvu-opening="djvuBannerOpening"');
        expect(presentationSource).toContain('const hasDjvuBannerOpeningContext = computed');
        expect(presentationSource).toContain('const djvuBannerOpening = computed');
        expect(presentationSource).toContain('options.isDocumentOpenPlaceholderVisible.value');
        expect(presentationSource).toContain('!options.initialDocumentVisualReady.value');
        expect(alertsSource).toContain('showDjvuConversionUi || djvuPendingOpen || djvuOpening');
        expect(alertsSource).toContain('djvuOpening || djvuShowBanner || djvuPendingOpen');
        expect(alertsSource).toContain(':is-opening="djvuOpening || djvuPendingOpen"');
        expect(alertsSource).not.toContain('defineAsyncComponent');
        expect(alertsSource).toContain('from \'@app/modules/djvu-viewer/public/component-exports/djvuBanner\'');
        expect(workspaceSource).not.toContain('WorkspaceDocumentTransitionSkeleton');
    });

    it('keeps one non-blank chassis page shell until the page-source or native-PDF image handoff commits', async () => {
        const [
            chassisSource,
            pageSourceFeatureSource,
        ] = await Promise.all([
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/DocumentViewerChassis.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue'),
                'utf8',
            ),
        ]);
        const openingShellStart = chassisSource.indexOf('<section');
        const openingShellEnd = chassisSource.indexOf('</section>', openingShellStart);
        const openingShell = chassisSource.slice(openingShellStart, openingShellEnd);
        const teleportedSurfaceStart = pageSourceFeatureSource.indexOf(
            '<Teleport',
            pageSourceFeatureSource.indexOf('v-for="pageNumber'),
        );
        const teleportedSurfaceEnd = pageSourceFeatureSource.indexOf('</Teleport>', teleportedSurfaceStart);
        const teleportedSurface = pageSourceFeatureSource.slice(
            teleportedSurfaceStart,
            teleportedSurfaceEnd,
        );

        expect(chassisSource).toContain('v-if="chassisOpeningPageShell && shouldRenderChassisOpeningPageShell"');
        expect(openingShell).toContain('<PdfPageSkeleton');
        expect(openingShell).toContain('chassisAuthority.openingPageVisual.value === \'skeleton\'');
        expect(openingShell).toContain(':content-height="chassisOpeningPageShell.height"');
        expect(chassisSource).toContain('overflow-anchor: none;');
        expect(chassisSource).toContain('props.rendererKind === \'native-pdf\'');
        expect(teleportedSurface).toContain('data-testid="document-page-source-image"');
        expect(teleportedSurface).not.toContain('document-source-viewer__skeleton');
        expect(pageSourceFeatureSource).toContain('shouldProjectDocumentViewportScroll(');
        expect(pageSourceFeatureSource).toContain('openSurface.snapshot.value.generation !== surfaceGeneration');
    });

    it('keeps the deferred workspace host from painting a detached opening surface', async () => {
        const [
            hostSource,
            loadGatewaySource,
        ] = await Promise.all([
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/components/DeferredDocumentWorkspaceHost.vue'),
                'utf8',
            ),
            readFile(
                join(process.cwd(), 'app/modules/workspace-shell/host/createDeferredWorkspaceLoadGateway.ts'),
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
        expect(hostSource).not.toContain('WorkspaceHostDocumentOpenFallback');
        expect(hostSource).not.toContain('<WorkspaceDocumentTransitionSkeleton />');
        expect(hostSource).not.toContain('AppSpinner');
        expect(hostSource).not.toContain('workspace-host__loading-chip');
        expect(hostSource).not.toContain('showHostDocumentOpenSkeleton');
        expect(hostSource).not.toContain('v-show="!isPlaceholderVisible"');
        expect(hostSource).not.toContain('surface.presentation === \'idle\'');
        expect(hostSource).toContain('shouldPresentDocumentOpenEmptyPlaceholder(documentOpenSurface.snapshot.value)');
        expect(hostSource).not.toContain('shouldShowWorkspacePlaceholder({');
        expect(hostSource).not.toContain('isRetainedEmptySnapshotVisible');
        expect(hostSource.match(/createDocumentOpenSurfaceSession\(\)/gu)).toHaveLength(1);
        expect(hostSource).not.toContain('createDocumentOpeningPageFrameAuthority');
        expect(hostSource).toContain('const openingPageFrameAuthority = shallowRef<IDocumentOpeningPageFrameAuthority | null>(null);');
        expect(hostSource).toContain('openingPageFrameAuthority.value?.draftOpeningPageFrame(preparedOpeningGeometry)');
        expect(hostSource).toContain('documentOpenSurface.beginPrepared(identity, preparedOpeningFrame)');
        const recentOpenStart = hostSource.indexOf('async function handleOpenRecentFromPlaceholder');
        const recentOpenEnd = hostSource.indexOf('\nasync function handleRemoveRecentFromPlaceholder', recentOpenStart);
        const recentOpenSource = hostSource.slice(recentOpenStart, recentOpenEnd);
        expect(recentOpenSource).not.toContain('prevalidateRecentPdfOpeningFrame');
        expect(recentOpenSource).toContain('return enqueueDocumentOpen({');
        const transactionStart = hostSource.indexOf('function beginDocumentOpenTransaction');
        const transactionEnd = hostSource.indexOf('\nasync function waitForDocumentOpenTerminalState', transactionStart);
        const transactionSource = hostSource.slice(transactionStart, transactionEnd);
        expect(transactionSource).not.toContain('Recent open rejected before transaction because its page frame is not prepared');
        expect(transactionSource).toContain('const preparedOpeningGeometry = resolvePreparedPdfOpeningGeometry');
        expect(transactionSource).toContain('const preparedOpeningFrame = preparedOpeningGeometry');
        expect(transactionSource).toContain('preparedOpeningGeometry ?? readRecentOpenExactGeometry(documentId)');
        expect(transactionSource.indexOf('documentOpenSurface.beginPrepared')).toBeLessThan(
            transactionSource.indexOf('createPendingWorkspaceDocumentRecord'),
        );
        const runStart = hostSource.indexOf('async function runWithDocumentOpenInFlight');
        const runEnd = hostSource.indexOf('\nasync function enqueueDocumentOpen', runStart);
        const runSource = hostSource.slice(runStart, runEnd);
        expect(runSource).toContain('documentOpenSurface.snapshot.value.presentation === \'page-shell\'');
        expect(runSource).toContain('await nextTick();');
        expect(runSource).not.toContain('waitForVisualFrames');
        expect(runSource.indexOf('await nextTick();')).toBeLessThan(
            runSource.indexOf('const result = await run();'),
        );
        const hostUnmountSource = hostSource.slice(hostSource.indexOf('onUnmounted(() => {'));
        expect(hostUnmountSource).toContain('documentOpenSurface.reset();');
        expect(hostSource).toContain('v-if="isPlaceholderVisible"');
        expect(hostSource).toContain('requestWorkspaceMount(`document-open:${intent.action}`)');
        expect(loadGatewaySource).toContain('requestWorkspaceMount(`ensureWorkspaceLoaded:${reason}`)');
    });
});
