import {createViewportAuthority} from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import {createPageNavigationRequest} from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';
import type {IPdfViewportIntent} from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const anchor = {
    page: 1,
    pageXFraction: 0.5,
    pageYFraction: 0,
    viewportXFraction: 0.5,
    viewportYFraction: 0,
    affinity: 'start' as const,
};

function intent(id: string, page: number): Omit<IPdfViewportIntent, 'interactionEpoch'> {
    return {
        id,
        kind: 'navigate',
        documentRevision: 1,
        geometryRevision: 1,
        priority: 10,
        supersessionKey: 'navigation',
        navigation: createPageNavigationRequest(page, 'toolbar'),
    };
}

describe('ViewportAuthority', () => {
    it('retains the old viewport until destination visual readiness commits', async () => {
        let releaseVisual!: () => void;
        const events: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getGeometryRevision: () => 1,
            resolve: async request => ({
                anchor: {
                    ...anchor,
                    page: request.navigation!.target.kind === 'page' ? request.navigation!.target.page : 1,
                },
                left: 0,
                top: 900,
            }),
            awaitMetrics: async () => { events.push('metrics'); },
            awaitSlots: async () => { events.push('slots'); },
            awaitVisual: () => new Promise<void>((resolve) => {
                events.push('visual-requested');
                releaseVisual = resolve;
            }),
            apply: () => { events.push('applied'); },
        });

        const pending = authority.submit(intent('visual', 2));
        await vi.waitFor(() => expect(events).toContain('visual-requested'));
        expect(events).not.toContain('applied');
        expect(authority.currentPage.value).toBe(1);
        releaseVisual();
        await expect(pending).resolves.toMatchObject({outcome: 'settled'});
        expect(events).toEqual([
            'metrics',
            'slots',
            'visual-requested',
            'applied',
        ]);
        expect(authority.currentPage.value).toBe(2);
        expect(authority.pendingTargetPage.value).toBeNull();
    });

    it('serializes intents, executes aborts, and permits only latest commit', async () => {
        const writes: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getGeometryRevision: () => 1,
            resolve: async request => ({
                anchor: {
                    ...anchor,
                    page: request.navigation!.target.kind === 'page' ? request.navigation!.target.page : 1,
                },
                left: 0,
                top: 10,
            }),
            awaitMetrics: (request, signal) => request.id === 'A'
                ? new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true}))
                : Promise.resolve(),
            awaitSlots: async () => {},
            apply: request => writes.push(request.id),
            awaitVisual: async () => {},
        });

        const stale = authority.submit(intent('A', 30));
        await Promise.resolve();
        const latest = authority.submit(intent('B', 928));
        await expect(stale).resolves.toMatchObject({outcome: 'cancelled'});
        await expect(latest).resolves.toMatchObject({outcome: 'settled'});
        expect(writes).toEqual(['B']);
        expect(authority.currentPage.value).toBe(928);
        expect(authority.getTerminalOutcome('A')).toBe('cancelled');
    });

    it('lets user scroll dominate delayed async work', async () => {
        let release!: () => void;
        const writes: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor,
                left: 0,
                top: 10,
            }),
            awaitMetrics: () => new Promise<void>(resolve => { release = resolve; }),
            awaitSlots: async () => {},
            apply: request => writes.push(request.id),
            awaitVisual: async () => {},
        });
        const pending = authority.submit(intent('restore', 8));
        await Promise.resolve();
        authority.observeUserScroll({
            ...anchor,
            page: 3,
        });
        release();
        await expect(pending).resolves.toMatchObject({outcome: 'cancelled'});
        expect(writes).toEqual([]);
        expect(authority.currentPage.value).toBe(3);
    });

    it('rejects a continuation when the document revision changes', async () => {
        let documentRevision = 1;
        let release!: () => void;
        const writes: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => documentRevision,
            getGeometryRevision: () => 1,
            resolve: async () => ({
                anchor,
                left: 0,
                top: 10,
            }),
            awaitMetrics: () => new Promise<void>((resolve) => { release = resolve; }),
            awaitSlots: async () => {},
            apply: request => writes.push(request.id),
            awaitVisual: async () => {},
        });

        const pending = authority.submit(intent('document-change', 2));
        await Promise.resolve();
        documentRevision = 2;
        release();

        await expect(pending).resolves.toMatchObject({outcome: 'cancelled'});
        expect(writes).toEqual([]);
    });

    it('rejects a continuation when the geometry revision changes', async () => {
        let geometryRevision = 1;
        let release!: () => void;
        const writes: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getGeometryRevision: () => geometryRevision,
            resolve: async () => ({
                anchor,
                left: 0,
                top: 10,
            }),
            awaitMetrics: async () => {},
            awaitSlots: async () => {},
            apply: request => writes.push(request.id),
            awaitVisual: () => new Promise<void>((resolve) => { release = resolve; }),
        });

        const pending = authority.submit(intent('geometry-change', 2));
        await vi.waitFor(() => expect(release).toBeTypeOf('function'));
        geometryRevision = 2;
        release();

        await expect(pending).resolves.toMatchObject({outcome: 'cancelled'});
        expect(writes).toEqual([]);
    });

    it('rebases geometry freshness after intent-owned metric hydration', async () => {
        let geometryRevision = 1;
        const writes: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getGeometryRevision: () => geometryRevision,
            resolve: async request => ({
                anchor: {
                    ...anchor,
                    page: request.navigation?.target.kind === 'page' ? request.navigation.target.page : 1,
                },
                left: 0,
                top: 10,
            }),
            awaitMetrics: async () => {
                geometryRevision += 1;
                return geometryRevision;
            },
            awaitSlots: async () => {},
            apply: request => writes.push(request.id),
            awaitVisual: async () => {},
        });

        await expect(authority.submit(intent('hydrate-metrics', 2)))
            .resolves
            .toMatchObject({outcome: 'settled'});
        expect(writes).toEqual(['hydrate-metrics']);
        expect(authority.currentPage.value).toBe(2);
    });

    it('generation-fences stale post-arrival effects', async () => {
        let releasePostArrival!: () => void;
        const effects: string[] = [];
        const authority = createViewportAuthority({
            getDocumentRevision: () => 1,
            getGeometryRevision: () => 1,
            resolve: async request => ({
                anchor: {
                    ...anchor,
                    page: request.navigation?.target.kind === 'page' ? request.navigation.target.page : 1,
                },
                left: 0,
                top: 10,
            }),
            awaitMetrics: async () => {},
            awaitSlots: async () => {},
            apply: () => {},
            awaitVisual: async () => {},
            postArrival: async (request, signal) => {
                if (request.source === 'search') {
                    await new Promise<void>((resolve) => { releasePostArrival = resolve; });
                }
                if (!signal.aborted) effects.push(request.source);
            },
        });
        const staleRequest = createPageNavigationRequest(2, 'search');
        staleRequest.postArrival = 'search-highlight';
        const stale = authority.submit({
            ...intent('stale-effect', 2),
            navigation: staleRequest,
        });
        await vi.waitFor(() => expect(releasePostArrival).toBeTypeOf('function'));
        const latest = authority.submit(intent('latest-effect', 3));
        releasePostArrival();
        await expect(stale).resolves.toMatchObject({outcome: 'cancelled'});
        await expect(latest).resolves.toMatchObject({outcome: 'settled'});
        expect(effects).toEqual(['toolbar']);
    });
});
