import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createWorkspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';
import {
    createThumbnailSurfaceResidency,
    type TThumbnailSurfaceDemand,
} from '@app/modules/pdf-viewer/thumbnails/createThumbnailSurfaceResidency';

interface ITestCanvas { id: string; }

function createHarness(maxBytes = 1_000) {
    const budget = createWorkspaceSurfaceBudgetController(maxBytes);
    const demandByPage = new Map<number, TThumbnailSurfaceDemand>();
    const evicted: number[] = [];
    const residency = createThumbnailSurfaceResidency<ITestCanvas>({
        budget,
        scopeId: 'thumbnail-test',
        resolveDemand: ({page}) => demandByPage.get(page) ?? 'cold',
        onEvict: ({page}) => evicted.push(page),
    });
    const canvas = (page: number) => ({id: `canvas-${String(page)}`});
    return {
        budget,
        canvas,
        demandByPage,
        evicted,
        residency,
    };
}

describe('thumbnail surface residency', () => {
    it('protects viewport thumbnails and reclaims cold thumbnails before full-page rasters', () => {
        const harness = createHarness();
        harness.demandByPage.set(17, 'viewport');
        harness.demandByPage.set(18, 'current');
        harness.demandByPage.set(19, 'viewport');
        harness.demandByPage.set(26, 'cold');
        for (const page of [
            17,
            18,
            19,
            26,
        ]) {
            harness.residency.register({
                page,
                canvas: harness.canvas(page),
            }, 100);
        }
        const evictFullPage = vi.fn();
        harness.budget.reserve({
            scopeId: 'full-page',
            category: 'pdf-page-canvas',
            bytes: 600,
            priority: 50,
            evict: evictFullPage,
        });

        harness.budget.setPressureLevel('critical');

        expect(harness.evicted).toEqual([26]);
        expect(evictFullPage).toHaveBeenCalledOnce();
        expect(harness.residency.getSnapshot().map(entry => entry.page)).toEqual([
            17,
            18,
            19,
        ]);
        expect(harness.budget.getSnapshot()).toMatchObject({
            effectiveMaxBytes: 500,
            reservedBytes: 300,
            reservedBytesByCategory: {'pdf-thumbnail-canvas': 300},
        });
    });

    it('protects the bounded current-page neighborhood while its geometry settles', () => {
        const harness = createHarness(800);
        harness.demandByPage.set(17, 'nearby');
        harness.demandByPage.set(18, 'current');
        harness.demandByPage.set(19, 'nearby');
        harness.demandByPage.set(25, 'cold');
        for (const page of [
            17,
            18,
            19,
            25,
        ]) {
            harness.residency.register({
                page,
                canvas: harness.canvas(page),
            }, 100);
        }

        harness.budget.reserve({
            scopeId: 'full-page',
            category: 'pdf-page-canvas',
            bytes: 500,
            priority: 50,
            evict: vi.fn(),
        });
        harness.budget.setPressureLevel('critical');

        expect(harness.evicted).toEqual([25]);
        expect(harness.residency.getSnapshot().map(entry => entry.page)).toEqual([
            17,
            18,
            19,
        ]);
    });

    it('transfers live demand instead of leaving former current pages permanently pinned', () => {
        const harness = createHarness(400);
        harness.demandByPage.set(10, 'current');
        harness.demandByPage.set(11, 'viewport');
        harness.residency.register({
            page: 10,
            canvas: harness.canvas(10),
        }, 200);
        harness.residency.register({
            page: 11,
            canvas: harness.canvas(11),
        }, 200);

        harness.demandByPage.set(10, 'cold');
        harness.demandByPage.set(11, 'current');
        harness.residency.reconcile();
        harness.budget.setPressureLevel('critical');

        expect(harness.evicted).toEqual([10]);
        expect(harness.residency.getSnapshot()).toEqual([expect.objectContaining({
            page: 11,
            demand: 'current',
            priority: 100,
        })]);
    });

    it('makes hidden panes reclaimable and releases detached canvas leases immediately', () => {
        const harness = createHarness(600);
        const canvases = new Map([
            [
                1,
                harness.canvas(1),
            ],
            [
                2,
                harness.canvas(2),
            ],
        ]);
        harness.demandByPage.set(1, 'current');
        harness.demandByPage.set(2, 'viewport');
        harness.residency.register({
            page: 1,
            canvas: canvases.get(1)!,
        }, 200);
        harness.residency.register({
            page: 2,
            canvas: canvases.get(2)!,
        }, 200);

        harness.residency.prune(new Set([2]), page => canvases.get(page) ?? null);
        expect(harness.budget.getSnapshot()).toMatchObject({
            leaseCount: 1,
            reservedBytes: 200,
        });

        harness.demandByPage.set(2, 'inactive');
        harness.residency.reconcile();
        harness.budget.setPressureLevel('post-crash-safe-mode');

        expect(harness.evicted).toEqual([2]);
        expect(harness.budget.getSnapshot()).toMatchObject({
            leaseCount: 0,
            reservedBytes: 0,
        });
    });

    it('keeps replacement, eviction, and cleanup identity-safe and idempotent', () => {
        const harness = createHarness(300);
        harness.demandByPage.set(4, 'cold');
        const first = harness.canvas(4);
        const replacement = {id: 'replacement'};
        harness.residency.register({
            page: 4,
            canvas: first,
        }, 200);
        harness.residency.register({
            page: 4,
            canvas: replacement,
        }, 200);

        expect(harness.budget.getSnapshot()).toMatchObject({
            leaseCount: 1,
            reservedBytes: 200,
        });
        expect(harness.residency.releasePage(4, first)).toBe(false);
        expect(harness.residency.releasePage(4, replacement)).toBe(true);
        expect(harness.residency.releasePage(4, replacement)).toBe(false);
        harness.residency.releaseAll();
        expect(harness.budget.getSnapshot()).toMatchObject({
            leaseCount: 0,
            reservedBytes: 0,
        });
    });
});
