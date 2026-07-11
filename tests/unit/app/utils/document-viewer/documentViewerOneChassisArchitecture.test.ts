import {
    readFileSync,
    realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { WORKSPACE_VIEWER_ADAPTERS } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

const root = realpathSync(process.cwd());
function read(relativePath: string) {
    return readFileSync(join(root, relativePath), 'utf8');
}

describe('one document viewer chassis architecture', () => {
    it('routes PDF, native-preview PDF, and DjVu adapters through the same chassis component', () => {
        const components = WORKSPACE_VIEWER_ADAPTERS.map(adapter => adapter.component);
        expect(new Set(components).size).toBe(1);
    });

    it('always mounts exactly one source-neutral viewport outside rendering feature packs', () => {
        const chassis = read('app/modules/workspace-shell/components/DocumentViewerChassis.vue');
        expect(chassis.match(/<DocumentViewportHost/gu)).toHaveLength(1);
        expect(chassis).toContain(':viewport-id="viewportId"');
        expect(chassis).toContain('? \'pdf-viewer\' : undefined');
        expect(chassis).toContain('<component');
        for (const path of [
            'app/modules/pdf-viewer/components/PdfViewerViewport.vue',
            'app/modules/native-pdf-viewer/components/NativePdfViewer.vue',
            'app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue',
        ]) {
            const feature = read(path);
            expect(feature, path).not.toContain('<DocumentViewportHost');
            expect(feature, path).toContain('bindViewportFeature');
        }
    });

    it('keeps active viewport mutations behind the chassis write port', () => {
        for (const path of [
            'app/modules/native-pdf-viewer/components/NativePdfViewer.vue',
            'app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue',
            'app/modules/pdf-viewer/runtime/composables/pdf/usePdfDrag.ts',
        ]) {
            const source = read(path);
            expect(source, path).not.toMatch(/\.scroll(?:Top|Left)\s*[-+]?=/u);
            expect(source, path).not.toMatch(/\.scrollTo\s*\(/u);
            expect(source, path).toContain('viewportWritePort');
        }
    });

    it('injects the chassis viewport authority into the optimized PDF feature pack', () => {
        const controller = read('app/modules/pdf-viewer/runtime/usePdfViewerFeatureController.ts');
        expect(controller).toContain('viewportWritePort: chassisAuthority?.viewportWritePort');
        expect(controller).toContain('viewportWritePort: viewerRuntime.scroll.viewportWritePort');
    });

    it('binds every renderer through the source-neutral document contract and preserves semantic restoration', () => {
        const native = read('app/modules/native-pdf-viewer/components/NativePdfViewer.vue');
        const djvu = read('app/modules/workspace-shell/components/DocumentPageSourceFeaturePack.vue');
        const chassis = read('app/modules/workspace-shell/components/DocumentViewerChassis.vue');

        expect(native).toContain('createPagePreviewDocumentSource');
        expect(native).toContain('chassisAuthority?.bindSource(boundPageSource)');
        expect(native).not.toContain('emit(\'update:currentPage\', 1)');
        expect(native).toContain('restoreScrollSnapshot');
        expect(djvu).toContain('restoreScrollSnapshot');
        expect(chassis).toContain('props.rendererKind');
        expect(chassis).not.toContain('pageSlots.cancelPending()');
        expect(chassis).toContain('nextViewer?.scrollToPage?.(fallbackPage)');
        expect(chassis).toContain('generation !== handoffGeneration');
        expect(chassis).toContain('sourceViewerRef.value !== nextViewer');
    });

    it('does not retain routine activation or fit retry schedulers', () => {
        const activation = read('app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore.ts');
        const rerender = read('app/modules/pdf-viewer/runtime/composables/usePdfViewerRerenderCoordinator.ts');
        expect(activation).not.toContain('requestAnimationFrame');
        expect(activation).not.toContain('forceRerender');
        expect(activation).not.toContain('ACTIVATION_RESTORE_CONTAINER_FRAME_LIMIT');
        expect(rerender).not.toContain('CURRENT_PAGE_FIT_RERENDER_SETTLE_MS');
        expect(rerender).not.toContain('FIT_HEIGHT_PRE_RENDER_SNAP_MAX_TICKS');
        expect(rerender).not.toContain('activeFitRerenderTransitionOwners');
    });
});
