import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IDocumentSurfaceLease} from '@app/utils/document-viewer/source/documentPageSource';
import {
    createDocumentThumbnailScheduler,
    type IDocumentThumbnailDemand,
} from '@app/utils/document-viewer/thumbnails/documentThumbnailScheduler';

interface IDeferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): IDeferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(nextResolve => {
        resolve = nextResolve;
    });
    return {
        promise,
        resolve,
    };
}

function demand(
    pageNumber: number,
    widthPx: number,
    rank = 1,
): IDocumentThumbnailDemand {
    return {
        distance: pageNumber,
        pageNumber,
        priority: rank === 0 ? 'navigation' : 'visible',
        quality: 'settled',
        rank,
        widthPx,
    };
}

function lease(widthPx: number, release = vi.fn()): IDocumentSurfaceLease {
    return {
        bytes: widthPx * 2,
        heightPx: widthPx * 2,
        release,
        surface: `thumbnail-${String(widthPx)}`,
        widthPx,
    };
}

describe('createDocumentThumbnailScheduler', () => {
    it('schedules navigation before nearby work and respects the concurrency limit', async () => {
        const pending: Array<IDeferred<IDocumentSurfaceLease>> = [];
        const started: number[] = [];
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 1,
            onStateChange: vi.fn(),
            prepareSurface: vi.fn(async () => undefined),
            render: vi.fn(request => {
                started.push(request.pageNumber);
                const item = deferred<IDocumentSurfaceLease>();
                pending.push(item);
                return item.promise;
            }),
        });

        scheduler.reconcile([
            demand(40, 128, 2),
            demand(12, 128, 0),
            demand(13, 128, 1),
        ]);
        expect(started).toEqual([12]);
        expect(scheduler.getSnapshot().activeCount).toBe(1);

        pending[0]!.resolve(lease(128));
        await Promise.resolve();
        await Promise.resolve();
        expect(started[1]).toBe(13);
        scheduler.dispose();
    });

    it('releases a cancelled stale lease once and commits only the replacement', async () => {
        const pending: Array<IDeferred<IDocumentSurfaceLease>> = [];
        const releases = [
            vi.fn(),
            vi.fn(),
        ];
        const committed: number[] = [];
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 1,
            onStateChange(_page, state) {
                if (state) committed.push(state.widthPx);
            },
            prepareSurface: vi.fn(async (_lease, signal) => signal.throwIfAborted()),
            render: vi.fn(() => {
                const item = deferred<IDocumentSurfaceLease>();
                pending.push(item);
                return item.promise;
            }),
        });

        scheduler.reconcile([demand(1, 128)]);
        scheduler.reconcile([demand(1, 256)]);
        pending[0]!.resolve(lease(128, releases[0]));
        await Promise.resolve();
        await Promise.resolve();
        expect(pending).toHaveLength(2);
        pending[1]!.resolve(lease(256, releases[1]));
        await scheduler.whenIdle();

        expect(committed).toEqual([256]);
        expect(releases[0]).toHaveBeenCalledTimes(1);
        expect(releases[1]).not.toHaveBeenCalled();
        scheduler.dispose();
        expect(releases[1]).toHaveBeenCalledTimes(1);
    });

    it('releases retained leases exactly once when demand disappears', async () => {
        const release = vi.fn();
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 2,
            onStateChange: vi.fn(),
            prepareSurface: vi.fn(async () => undefined),
            render: vi.fn(async () => lease(128, release)),
        });

        scheduler.reconcile([demand(7, 128)]);
        await scheduler.whenIdle();
        scheduler.reconcile([]);
        scheduler.dispose();

        expect(release).toHaveBeenCalledTimes(1);
    });

    it('treats the requested bucket as settled when a provider returns a smaller native raster', async () => {
        const render = vi.fn(async () => lease(180));
        const scheduler = createDocumentThumbnailScheduler({
            maxConcurrency: 1,
            onStateChange: vi.fn(),
            prepareSurface: vi.fn(async () => undefined),
            render,
        });

        scheduler.reconcile([demand(3, 256)]);
        await scheduler.whenIdle();
        scheduler.reconcile([demand(3, 256)]);
        await scheduler.whenIdle();

        expect(render).toHaveBeenCalledTimes(1);
        scheduler.dispose();
    });
});
