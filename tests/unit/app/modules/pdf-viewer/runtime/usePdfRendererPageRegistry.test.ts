import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfRendererPageRegistry } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererPageRegistry';
import { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';

function createCanvas(width: number, height: number) {
    return {
        width,
        height,
    } as HTMLCanvasElement;
}

describe('PDF renderer page surface registry', () => {
    afterEach(() => {
        workspaceSurfaceBudgetController.setPressureLevel('healthy');
    });

    it('keeps a staged replacement protected, then evicts its page and annotation backing stores after commit', () => {
        const registry = usePdfRendererPageRegistry();
        const canvas = createCanvas(
            Math.ceil(workspaceSurfaceBudgetController.getSnapshot().maxBytes / 4) + 1,
            1,
        );
        const annotationCanvas = createCanvas(20, 10);
        const lease = registry.reservePageCanvasSurface(1, canvas, [annotationCanvas]);
        registry.pageCanvases.set(1, canvas);
        registry.renderedPages.add(1);
        registry.replacePageCanvasSurfaceLease(1, lease);

        workspaceSurfaceBudgetController.setPressureLevel('emergency');
        expect(canvas.width).toBeGreaterThan(0);
        expect(registry.renderedPages.has(1)).toBe(true);

        registry.markPageCanvasSurfaceEvictable(1);

        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
        expect(annotationCanvas.width).toBe(0);
        expect(annotationCanvas.height).toBe(0);
        expect(registry.pageCanvases.has(1)).toBe(false);
        expect(registry.renderedPages.has(1)).toBe(false);
        registry.releaseAllSurfaceResources();
    });

    it('accounts old and new page plus annotation surfaces until a replacement is installed', () => {
        const registry = usePdfRendererPageRegistry();
        const baseline = workspaceSurfaceBudgetController.getSnapshot().reservedBytes;
        const oldCanvas = createCanvas(10, 10);
        const oldAnnotation = createCanvas(5, 5);
        const oldLease = registry.reservePageCanvasSurface(4, oldCanvas, [oldAnnotation]);
        registry.pageCanvases.set(4, oldCanvas);
        registry.replacePageCanvasSurfaceLease(4, oldLease);
        registry.markPageCanvasSurfaceEvictable(4);

        const newCanvas = createCanvas(20, 10);
        const newAnnotation = createCanvas(4, 5);
        const newLease = registry.reservePageCanvasSurface(4, newCanvas, [newAnnotation]);
        expect(workspaceSurfaceBudgetController.getSnapshot().reservedBytes - baseline).toBe(
            (10 * 10 * 4) + (5 * 5 * 4) + (20 * 10 * 4) + (4 * 5 * 4),
        );

        registry.pageCanvases.set(4, newCanvas);
        registry.replacePageCanvasSurfaceLease(4, newLease);
        expect(workspaceSurfaceBudgetController.getSnapshot().reservedBytes - baseline).toBe(
            (20 * 10 * 4) + (4 * 5 * 4),
        );
        registry.releaseAllSurfaceResources();
    });

    it('protects the visible page from pressure eviction and reports eviction after it leaves the window', () => {
        let protectedPage = 1;
        const onPageEvicted = vi.fn();
        const registry = usePdfRendererPageRegistry({
            isPageProtected: pageNumber => pageNumber === protectedPage,
            onPageEvicted,
        });
        const canvas = createCanvas(
            Math.ceil(workspaceSurfaceBudgetController.getSnapshot().effectiveMaxBytes / 4) + 1,
            1,
        );
        const lease = registry.reservePageCanvasSurface(1, canvas);
        registry.pageCanvases.set(1, canvas);
        registry.renderedPages.add(1);
        registry.replacePageCanvasSurfaceLease(1, lease);
        registry.markPageCanvasSurfaceEvictable(1);

        workspaceSurfaceBudgetController.setPressureLevel('emergency');
        expect(canvas.width).toBeGreaterThan(0);
        expect(onPageEvicted).not.toHaveBeenCalled();

        protectedPage = 2;
        workspaceSurfaceBudgetController.enforceBudget();
        expect(canvas.width).toBe(0);
        expect(onPageEvicted).toHaveBeenCalledExactlyOnceWith(1);
        registry.releaseAllSurfaceResources();
    });

    it('releases every page and annotation reservation when the document closes', () => {
        const registry = usePdfRendererPageRegistry();
        const baseline = workspaceSurfaceBudgetController.getSnapshot().reservedBytes;
        for (const pageNumber of [
            1,
            2,
        ]) {
            const canvas = createCanvas(10, 10);
            const lease = registry.reservePageCanvasSurface(pageNumber, canvas, [createCanvas(5, 5)]);
            registry.pageCanvases.set(pageNumber, canvas);
            registry.replacePageCanvasSurfaceLease(pageNumber, lease);
        }
        expect(workspaceSurfaceBudgetController.getSnapshot().reservedBytes).toBeGreaterThan(baseline);

        registry.releaseAllSurfaceResources();

        expect(workspaceSurfaceBudgetController.getSnapshot().reservedBytes).toBe(baseline);
    });
});
