import type {
    IWorkspaceSurfaceBudgetController,
    IWorkspaceSurfaceLease,
} from '@app/utils/document-viewer/workspaceSurfaceBudget';

export type TThumbnailSurfaceDemand =
    | 'current'
    | 'viewport'
    | 'nearby'
    | 'cold'
    | 'inactive';

interface IThumbnailSurfaceIdentity<TCanvas extends object> {
    canvas: TCanvas;
    page: number;
}

interface IThumbnailSurfaceEntry<TCanvas extends object> extends IThumbnailSurfaceIdentity<TCanvas> {lease: IWorkspaceSurfaceLease;}

interface ICreateThumbnailSurfaceResidencyOptions<TCanvas extends object> {
    budget: IWorkspaceSurfaceBudgetController;
    onEvict: (identity: IThumbnailSurfaceIdentity<TCanvas>) => void;
    resolveDemand: (identity: IThumbnailSurfaceIdentity<TCanvas>) => TThumbnailSurfaceDemand;
    scopeId: string;
}

const THUMBNAIL_SURFACE_PRIORITY: Record<TThumbnailSurfaceDemand, number> = {
    current: 100,
    viewport: 90,
    nearby: 60,
    cold: 10,
    inactive: 0,
};

function isThumbnailSurfaceDemandProtected(demand: TThumbnailSurfaceDemand) {
    // The immediate neighborhood is deliberately tiny (current page +/- the
    // runtime's immediate render radius), but it is part of the user-visible
    // navigation surface. Geometry can move a neighbor into the viewport while
    // thumbnail aspect ratios settle, so evicting it as "nearby" produces a
    // conspicuous blank immediately above or below the current page.
    return demand === 'current' || demand === 'viewport' || demand === 'nearby';
}

function resolveThumbnailSurfacePriority(demand: TThumbnailSurfaceDemand) {
    return THUMBNAIL_SURFACE_PRIORITY[demand];
}

export function createThumbnailSurfaceResidency<TCanvas extends object>(
    options: ICreateThumbnailSurfaceResidencyOptions<TCanvas>,
) {
    const entries = new Map<number, IThumbnailSurfaceEntry<TCanvas>>();

    function releaseEntry(entry: IThumbnailSurfaceEntry<TCanvas>) {
        if (entries.get(entry.page) === entry) {
            entries.delete(entry.page);
        }
        entry.lease.release();
    }

    function releasePage(page: number, canvas?: TCanvas) {
        const entry = entries.get(page);
        if (!entry || (canvas && entry.canvas !== canvas)) {
            return false;
        }
        releaseEntry(entry);
        return true;
    }

    function reconcile() {
        for (const entry of entries.values()) {
            entry.lease.setPriority?.(resolveThumbnailSurfacePriority(options.resolveDemand(entry)));
        }
    }

    function register(identity: IThumbnailSurfaceIdentity<TCanvas>, bytes: number) {
        releasePage(identity.page);
        let committed = false;
        let entry: IThumbnailSurfaceEntry<TCanvas> | null = null;
        const lease = options.budget.reserve({
            scopeId: options.scopeId,
            category: 'pdf-thumbnail-canvas',
            bytes,
            priority: resolveThumbnailSurfacePriority(options.resolveDemand(identity)),
            canEvict: () => committed && !isThumbnailSurfaceDemandProtected(options.resolveDemand(identity)),
            evict: () => {
                if (!entry || entries.get(identity.page) !== entry) {
                    return;
                }
                entries.delete(identity.page);
                options.onEvict(identity);
            },
        });
        entry = {
            ...identity,
            lease,
        };
        entries.set(identity.page, entry);
        committed = true;
        options.budget.enforceBudget();
        return entries.get(identity.page) === entry;
    }

    function prune(
        mountedPages: ReadonlySet<number>,
        resolveCanvas: (page: number) => TCanvas | null,
    ) {
        for (const entry of [...entries.values()]) {
            if (mountedPages.has(entry.page) && resolveCanvas(entry.page) === entry.canvas) {
                continue;
            }
            releaseEntry(entry);
        }
    }

    function releaseAll() {
        for (const entry of [...entries.values()]) {
            releaseEntry(entry);
        }
        options.budget.releaseScope(options.scopeId);
    }

    return {
        getSnapshot: () => [...entries.values()].map(entry => ({
            canvas: entry.canvas,
            demand: options.resolveDemand(entry),
            page: entry.page,
            priority: resolveThumbnailSurfacePriority(options.resolveDemand(entry)),
        })),
        prune,
        reconcile,
        register,
        releaseAll,
        releasePage,
    };
}
