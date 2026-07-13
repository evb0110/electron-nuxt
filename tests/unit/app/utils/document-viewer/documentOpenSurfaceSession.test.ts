import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDocumentOpenSurfaceSession,
    resolveDocumentOpenSurfaceViewportPolicy,
    shouldProjectDocumentViewportScroll,
    shouldPresentDocumentOpenEmptyPlaceholder,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentOpenSurfaceRenderFence } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

function createViewportCommit(fence: IDocumentOpenSurfaceRenderFence) {
    return {
        generation: fence.generation,
        documentRevision: fence.documentRevision,
        viewportIntentId: fence.viewportIntentId,
        documentGeometryRevision: 1,
        interactionEpoch: 0,
        pageNumber: fence.pageNumber,
        left: 0,
        top: 0,
    };
}

describe('document open surface session', () => {
    it('rejects navigation until an opening session owns the document', () => {
        const session = createDocumentOpenSurfaceSession();

        for (let page = 2; page <= 6; page += 1) {
            expect(session.requestNavigation(page)).toBe(1);
        }
        expect(session.viewportSession.value.identity).toBeNull();
        expect(session.viewportSession.value.requestedPage).toBe(1);

        session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });

        expect(session.viewportSession.value.identity).toEqual({
            documentId: 'scan.pdf',
            revision: 'open-intent:1',
        });
        expect(session.viewportSession.value.requestedPage).toBe(1);
        expect(session.viewportSession.value.viewportIntent?.pageNumber).toBe(1);
    });

    it('clears unclaimed navigation when the surface resets', () => {
        const session = createDocumentOpenSurfaceSession();
        session.requestNavigation(6);

        session.reset();
        session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });

        expect(session.viewportSession.value.requestedPage).toBe(1);
    });

    it('translates surface fences after close advances the viewport generation', () => {
        const session = createDocumentOpenSurfaceSession();
        session.begin({
            documentId: 'first.pdf',
            documentRevision: 'revision-1',
        });
        session.reset();

        const surfaceGeneration = session.begin({
            documentId: 'second.pdf',
            documentRevision: 'revision-2',
        });
        expect(session.viewportSession.value.generation).not.toBe(surfaceGeneration);
        expect(session.commitGeometry(surfaceGeneration, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        const fence = session.createRenderFence({
            generation: surfaceGeneration,
            documentRevision: 'revision-2',
            renderVersion: 2,
            requestId: 1,
            pageNumber: 1,
        });

        expect(fence).not.toBeNull();
        expect(session.commitCanvas(fence!)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence!))).toBe(true);
        expect(session.markReady(fence!)).toBe(true);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            committedPage: 1,
        });
    });

    it('projects open, metadata, navigation debounce, and close through one viewport session', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'opening',
            requestedPage: 1,
            committedPage: null,
            visual: {
                kind: 'page',
                presentation: 'cold-shell',
            },
        });
        vi.advanceTimersByTime(119);
        expect(session.viewportSession.value.visual).toMatchObject({presentation: 'cold-shell'});
        vi.advanceTimersByTime(1);
        expect(session.viewportSession.value.visual).toMatchObject({presentation: 'skeleton'});
        expect(session.commitOpeningPageGeometry(generation, {
            documentId: 'scan.pdf',
            pageNumber: 1,
            pageCount: 20,
            width: 612,
            height: 792,
            rotation: 0,
        })).toBe(true);
        expect(session.viewportSession.value.pageCount).toBe(20);

        expect(session.requestNavigation(7, 120)).toBe(7);
        expect(session.viewportSession.value.visual).toMatchObject({
            kind: 'page',
            presentation: 'cold-shell',
            pageNumber: 7,
        });
        vi.advanceTimersByTime(120);
        expect(session.viewportSession.value.visual).toMatchObject({
            kind: 'page',
            presentation: 'skeleton',
            pageNumber: 7,
        });

        session.reset();
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'empty',
            identity: null,
            committedPage: null,
        });
        vi.useRealTimers();
    });

    it('cannot let a superseded skeleton deadline overwrite a newer page or committed canvas', () => {
        vi.useFakeTimers();
        vi.setSystemTime(2_000);
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.djvu',
            documentRevision: 'djvu:1',
        });
        expect(session.commitOpeningPageGeometry(generation, {
            documentId: 'scan.djvu',
            pageNumber: 1,
            pageCount: 10,
            width: 600,
            height: 800,
            rotation: 0,
        })).toBe(true);
        expect(session.commitGeometry(generation, {
            width: 600,
            height: 800,
            margin: 16,
        })).toBe(true);

        vi.advanceTimersByTime(50);
        session.requestNavigation(2, 120);
        vi.advanceTimersByTime(70);
        expect(session.viewportSession.value.visual).toMatchObject({
            pageNumber: 2,
            presentation: 'cold-shell',
        });

        session.requestNavigation(3, 120);
        const fence = session.createRenderFence({
            generation,
            documentRevision: 'djvu:1',
            renderVersion: 1,
            requestId: 3,
            pageNumber: 3,
        })!;
        expect(session.commitCanvas(fence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence))).toBe(true);
        expect(session.markReady(fence)).toBe(true);

        vi.advanceTimersByTime(1_000);
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 3,
            committedPage: 3,
            visual: {
                pageNumber: 3,
                presentation: 'canvas',
            },
        });
        vi.useRealTimers();
    });

    it('keeps the current intent and fences when a viewport commit repeats the requested page', () => {
        vi.useFakeTimers();
        vi.setSystemTime(3_000);
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        expect(session.commitOpeningPageGeometry(generation, {
            documentId: 'scan.pdf',
            pageNumber: 1,
            pageCount: 10,
            width: 612,
            height: 792,
            rotation: 0,
        })).toBe(true);
        expect(session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        session.requestNavigation(7, 120);
        const intentId = session.viewportSession.value.viewportIntent?.id;
        const fence = session.createRenderFence({
            generation,
            documentRevision: 'revision-1',
            renderVersion: 2,
            requestId: 7,
            pageNumber: 7,
        })!;

        expect(session.requestNavigation(7, 120)).toBe(7);
        expect(session.viewportSession.value.viewportIntent?.id).toBe(intentId);
        expect(session.commitCanvas(fence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence))).toBe(true);
        expect(session.markReady(fence)).toBe(true);

        vi.advanceTimersByTime(1_000);
        expect(session.viewportSession.value).toMatchObject({
            committedPage: 7,
            requestedPage: 7,
            visual: {
                pageNumber: 7,
                presentation: 'canvas',
            },
        });
        vi.useRealTimers();
    });

    it('invalidates source-page geometry when empty-surface navigation targets another page', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.beginPrepared({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        }, {
            documentId: 'scan.pdf',
            ownerId: 'opening-frame-owner',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '900x700',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: 'scan.pdf:28',
            style: {
                width: '612px',
                height: '792px',
            },
            geometry: {
                documentId: 'scan.pdf',
                pageNumber: 1,
                pageCount: 20,
                width: 612,
                height: 792,
                rotation: 0,
            },
        });
        expect(generation).toBe(1);

        expect(session.requestNavigation(7)).toBe(7);
        expect(session.snapshot.value).toMatchObject({
            generation,
            presentation: 'page-shell',
            openingPageGeometry: null,
            openingPageFrame: null,
        });
        expect(session.viewportSession.value.requestedPage).toBe(7);
        expect(session.viewportSession.value).toMatchObject({
            generation,
            requestedPage: 7,
            visual: {
                kind: 'page',
                pageNumber: 7,
            },
        });
    });
    it('accepts authoritative transient page geometry without a cache fingerprint', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'pdfjs:4',
        });

        expect(session.commitOpeningPageGeometry(generation, {
            documentId: 'scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
        })).toBe(true);
        expect(session.snapshot.value.openingPageGeometry).toEqual({
            documentId: 'scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
        });
    });

    it('carries exact prevalidated geometry into the empty-to-document generation', () => {
        const session = createDocumentOpenSurfaceSession();
        const openingPageGeometry = {
            documentId: 'scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
            size: 28_000_000,
            modifiedAt: 1_750_000_000_000,
        };

        session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        }, openingPageGeometry);
        openingPageGeometry.width = 1;

        expect(session.snapshot.value.openingPageGeometry).toEqual({
            ...openingPageGeometry,
            width: 612,
        });
    });

    it('rejects opening geometry that belongs to a different document identity', () => {
        const session = createDocumentOpenSurfaceSession();
        const wrongGeometry = {
            documentId: 'wrong.pdf',
            pageNumber: 7,
            pageCount: 10,
            width: 612,
            height: 792,
            rotation: 0,
        };
        const generation = session.begin({
            documentId: 'expected.pdf',
            documentRevision: 'open-intent:1',
        }, wrongGeometry);

        expect(session.snapshot.value.openingPageGeometry).toBeNull();
        expect(session.viewportSession.value.requestedPage).toBe(1);
        expect(session.commitOpeningPageGeometry(generation, wrongGeometry)).toBe(false);
        expect(session.snapshot.value.openingPageGeometry).toBeNull();
    });

    it('joins late prevalidated geometry only into the current pending generation', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });
        const geometry = {
            documentId: 'scan.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
            size: 28_000_000,
            modifiedAt: 1_750_000_000_000,
        };

        expect(session.commitOpeningPageGeometry(generation, geometry)).toBe(true);
        geometry.width = 1;
        expect(session.snapshot.value.openingPageGeometry?.width).toBe(612);

        const nextGeneration = session.supersede()!;
        expect(session.commitOpeningPageGeometry(generation, geometry)).toBe(false);
        expect(nextGeneration).toBe(generation + 1);
    });

    it('uses the same empty page-shell transition for a replacement open', () => {
        const session = createDocumentOpenSurfaceSession();
        session.begin({
            documentId: 'first.pdf',
            documentRevision: 'open-intent:1',
        });
        expect(session.snapshot.value.presentation).toBe('idle');

        const generation = session.snapshot.value.generation;
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const fence = session.createRenderFence({
            generation,
            documentRevision: 'open-intent:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        session.commitCanvas(fence);
        session.commitViewport(createViewportCommit(fence));
        session.markReady(fence);

        const replacementGeneration = session.begin({
            documentId: 'second.pdf',
            documentRevision: 'open-intent:2',
        }, {
            documentId: 'second.pdf',
            pageNumber: 1,
            pageCount: 12,
            width: 612,
            height: 792,
            rotation: 0,
        });
        expect(session.snapshot.value.presentation).toBe('idle');
        expect(session.commitOpeningPageFrame(replacementGeneration, {
            generation: replacementGeneration,
            ownerId: 'pdfjs',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '612px',
                height: '792px',
            },
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');
    });
    it('atomically promotes a provisional revision without revoking its visual generation', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'pending.pdf',
            documentRevision: 'open-intent:1',
        });
        session.requestNavigation(6);
        const provisionalFence = session.createRenderFence({
            generation,
            documentRevision: 'open-intent:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 6,
        })!;
        const provisionalViewport = createViewportCommit(provisionalFence);

        const claimedGeneration = session.claim({
            documentId: 'pending.pdf',
            documentRevision: 'canonical-revision',
        });

        expect(claimedGeneration).toBe(generation);
        expect(session.snapshot.value.identity?.documentRevision).toBe('canonical-revision');
        expect(session.viewportSession.value).toMatchObject({
            generation,
            requestedPage: 6,
            identity: {
                documentId: 'pending.pdf',
                revision: 'canonical-revision',
            },
        });
        expect(session.createRenderFence({
            ...provisionalFence,
            generation: claimedGeneration,
        })).toBeNull();
        expect(session.commitCanvas(provisionalFence)).toBe(false);
        expect(session.commitViewport(provisionalViewport)).toBe(false);
        expect(session.createRenderFence({
            ...provisionalFence,
            generation: claimedGeneration,
            documentRevision: 'canonical-revision',
        })?.documentRevision).toBe('canonical-revision');
    });

    it('preserves committed geometry when a provisional identity is refined before rendering', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'pending.pdf',
            documentRevision: 'open-intent:1',
        });
        expect(session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);

        const claimedGeneration = session.claim({
            documentId: 'pending.pdf',
            documentRevision: 'load:1',
        });
        expect(claimedGeneration).toBe(generation);
        expect(session.snapshot.value).toMatchObject({
            generation: claimedGeneration,
            phase: 'geometry-committed',
            identity: {
                documentId: 'pending.pdf',
                documentRevision: 'load:1',
            },
            geometry: {
                width: 612,
                height: 792,
                margin: 20,
            },
            openingPageGeometry: null,
            openingPageFrame: null,
            committedRender: null,
            committedViewport: null,
        });
    });

    it('rejects caller revision mismatches instead of relabelling render evidence', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'pending.pdf',
            documentRevision: 'load:1',
        });
        const input = {
            generation,
            documentRevision: 'open-intent:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        };

        expect(session.createRenderFence(input)).toBeNull();
        expect(session.createRenderFence({
            ...input,
            documentRevision: 'load:1',
        })).toEqual({
            ...input,
            documentRevision: 'load:1',
            viewportIntentId: 'open:1',
        });
    });

    it('supersedes committed fences instead of relabelling them when identity is refined late', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'pending.pdf',
            documentRevision: 'open-intent:1',
        });
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const fence = session.createRenderFence({
            generation,
            documentRevision: 'open-intent:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        expect(session.commitCanvas(fence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence))).toBe(true);

        const claimedGeneration = session.claim({
            documentId: 'pending.pdf',
            documentRevision: 'load:1',
        });
        expect(claimedGeneration).toBe(generation + 1);
        expect(session.snapshot.value).toMatchObject({
            generation: generation + 1,
            phase: 'pending',
            identity: {
                documentId: 'pending.pdf',
                documentRevision: 'load:1',
            },
            committedRender: null,
            committedViewport: null,
        });
        expect(session.markReady(fence)).toBe(false);
    });

    it('starts a clean generation when a rapid second document claims an active open', () => {
        const session = createDocumentOpenSurfaceSession();
        const firstGeneration = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'open-intent:a',
        });
        session.commitGeometry(firstGeneration, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const staleFence = session.createRenderFence({
            generation: firstGeneration,
            documentRevision: 'open-intent:a',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        session.commitCanvas(staleFence);

        expect(session.claim({
            documentId: 'b.pdf',
            documentRevision: 'open-intent:b',
        })).toBe(firstGeneration + 1);
        expect(session.snapshot.value).toMatchObject({
            generation: firstGeneration + 1,
            phase: 'pending',
            identity: {
                documentId: 'b.pdf',
                documentRevision: 'open-intent:b',
            },
            geometry: null,
            openingPageGeometry: null,
            openingPageFrame: null,
            committedRender: null,
            committedViewport: null,
        });
        expect(session.commitCanvas(staleFence)).toBe(false);
    });

    it('rejects canvas commits from a superseded open generation', () => {
        const session = createDocumentOpenSurfaceSession();
        const firstGeneration = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        const staleFence = session.createRenderFence({
            generation: firstGeneration,
            documentRevision: 'rev-a',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        });
        expect(firstGeneration).toBe(1);
        expect(staleFence).not.toBeNull();

        session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b',
        });

        expect(session.commitCanvas(staleFence!)).toBe(false);
        expect(session.snapshot.value.phase).toBe('pending');
        expect(session.snapshot.value.identity?.documentId).toBe('b.pdf');
    });

    it('rejects every late commit after teardown reset and a replacement begin', () => {
        const session = createDocumentOpenSurfaceSession();
        const firstGeneration = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        }, {
            documentId: 'a.pdf',
            pageNumber: 1,
            pageCount: 1,
            width: 612,
            height: 792,
            rotation: 0,
        });
        expect(session.commitGeometry(firstGeneration, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        const staleFence = session.createRenderFence({
            generation: firstGeneration,
            documentRevision: 'rev-a',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        });
        expect(staleFence).not.toBeNull();

        session.reset();
        const replacementGeneration = session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b',
        });

        expect(session.commitCanvas(staleFence!)).toBe(false);
        expect(session.commitOpeningPageGeometry(firstGeneration, {
            documentId: 'a.pdf',
            pageNumber: 1,
            pageCount: 1,
            width: 612,
            height: 792,
            rotation: 0,
        })).toBe(false);
        expect(session.snapshot.value).toMatchObject({
            generation: replacementGeneration,
            identity: {
                documentId: 'b.pdf',
                documentRevision: 'rev-b',
            },
            phase: 'pending',
            openingPageGeometry: null,
            openingPageFrame: null,
            committedRender: null,
            committedViewport: null,
        });
    });

    it('requires exact committed render identity before releasing the surface', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        expect(session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        const committedFence = session.createRenderFence({
            generation,
            documentRevision: 'rev-a',
            renderVersion: 3,
            requestId: 7,
            pageNumber: 1,
        })!;
        const differentRequest = {
            ...committedFence,
            requestId: 8,
        };

        expect(session.commitCanvas(committedFence)).toBe(true);
        expect(session.markReady(differentRequest)).toBe(false);
        expect(session.snapshot.value.phase).toBe('canvas-committed');
        expect(session.commitViewport(createViewportCommit({
            ...differentRequest,
            pageNumber: 2,
        }))).toBe(false);
        expect(session.snapshot.value.phase).toBe('canvas-committed');
        expect(session.snapshot.value.committedViewport).toBeNull();
        expect(session.commitViewport(createViewportCommit(committedFence))).toBe(true);
        expect(session.snapshot.value.phase).toBe('viewport-committed');
        expect(session.markReady(committedFence)).toBe(true);
        expect(session.snapshot.value.phase).toBe('ready');
    });

    it('settles ready-phase navigation from the current requested-page render and viewport commits', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.djvu',
            documentRevision: 'djvu:1',
        });
        session.metadataReady(12);
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        });
        const openingFence = session.createRenderFence({
            generation,
            documentRevision: 'djvu:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        session.commitCanvas(openingFence);
        session.commitViewport(createViewportCommit(openingFence));
        expect(session.markReady(openingFence)).toBe(true);

        expect(session.requestNavigation(7)).toBe(7);
        const navigationFence = session.createRenderFence({
            generation,
            documentRevision: 'djvu:1',
            renderVersion: 1,
            requestId: 2,
            pageNumber: 7,
        })!;
        expect(session.commitCanvas(openingFence)).toBe(false);
        expect(session.commitCanvas(navigationFence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(navigationFence))).toBe(true);
        expect(session.markReady(navigationFence)).toBe(true);

        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 7,
            committedPage: 7,
            visual: {
                kind: 'page',
                pageNumber: 7,
                presentation: 'canvas',
            },
        });
        expect(session.snapshot.value).toMatchObject({
            phase: 'ready',
            presentation: 'committed',
            committedRender: navigationFence,
            committedViewport: {pageNumber: 7},
        });
    });

    it('does not bind a late opening-page completion to a newer early-navigation intent', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'pdfjs:1',
        });
        session.metadataReady(20);
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const openingFence = session.createRenderFence({
            generation,
            documentRevision: 'pdfjs:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        const openingViewport = createViewportCommit(openingFence);

        expect(session.requestNavigation(7)).toBe(7);
        expect(session.createRenderFence({
            generation,
            documentRevision: 'pdfjs:1',
            renderVersion: 2,
            requestId: 2,
            pageNumber: 1,
        })).toBeNull();
        expect(session.commitCanvas(openingFence)).toBe(false);
        expect(session.commitViewport(openingViewport)).toBe(false);
        expect(session.snapshot.value).toMatchObject({
            phase: 'geometry-committed',
            committedRender: null,
            committedViewport: null,
        });
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'opening',
            requestedPage: 7,
            committedRenderFence: null,
            committedViewportFence: null,
        });

        const navigationFence = session.createRenderFence({
            generation,
            documentRevision: 'pdfjs:1',
            renderVersion: 1,
            requestId: 3,
            pageNumber: 7,
        })!;
        expect(navigationFence.viewportIntentId).not.toBe(openingFence.viewportIntentId);
        expect(session.commitCanvas(navigationFence)).toBe(true);
        expect(session.commitViewport(createViewportCommit(navigationFence))).toBe(true);
        expect(session.markReady(navigationFence)).toBe(true);
        expect(session.viewportSession.value.committedPage).toBe(7);
    });

    it('leaves both session snapshots untouched when a viewport commit has a rejected intent', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'pdfjs:1',
        });
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const fence = session.createRenderFence({
            generation,
            documentRevision: 'pdfjs:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        expect(session.commitCanvas(fence)).toBe(true);
        const surfaceBefore = session.snapshot.value;
        const viewportBefore = session.viewportSession.value;

        expect(session.commitViewport({
            ...createViewportCommit(fence),
            viewportIntentId: 'superseded-intent',
        })).toBe(false);
        expect(session.snapshot.value).toBe(surfaceBefore);
        expect(session.viewportSession.value).toBe(viewportBefore);
        expect(session.snapshot.value.committedViewport).toBeNull();
        expect(session.viewportSession.value.committedViewportFence).toBeNull();
    });

    it('terminalizes a failed current navigation without letting the skeleton timer survive', () => {
        vi.useFakeTimers();
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.djvu',
            documentRevision: 'djvu:1',
        });
        session.metadataReady(12);
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        });
        const openingFence = session.createRenderFence({
            generation,
            documentRevision: 'djvu:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        session.commitCanvas(openingFence);
        session.commitViewport(createViewportCommit(openingFence));
        session.markReady(openingFence);

        session.requestNavigation(7, 120);
        const navigationFence = session.createRenderFence({
            generation,
            documentRevision: 'djvu:1',
            renderVersion: 1,
            requestId: 2,
            pageNumber: 7,
        })!;
        expect(session.reject(navigationFence, 'Unable to display page 7')).toBe(true);
        vi.advanceTimersByTime(120);

        expect(session.snapshot.value).toMatchObject({
            phase: 'failed',
            presentation: 'failed',
            failure: 'Unable to display page 7',
        });
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'failed',
            requestedPage: 7,
            skeletonDelay: null,
            visual: {
                kind: 'page',
                pageNumber: 7,
                presentation: 'error',
                error: 'Unable to display page 7',
            },
        });
        expect(session.reject(openingFence, 'stale opening failure')).toBe(false);
        vi.useRealTimers();
    });

    it('terminalizes a page-source failure that occurs before a render fence exists', () => {
        vi.useFakeTimers();
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'oversized.pdf',
            documentRevision: 'native:1',
        });
        session.metadataReady(431);
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        });
        const openingFence = session.createRenderFence({
            generation,
            documentRevision: 'native:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        session.commitCanvas(openingFence);
        session.commitViewport(createViewportCommit(openingFence));
        session.markReady(openingFence);

        session.requestNavigation(5, 120);
        expect(session.viewportSession.value.renderFence).toBeNull();
        expect(session.failPageTransition(5, 'Native preview failed')).toBe(true);
        vi.advanceTimersByTime(120);

        expect(session.snapshot.value.phase).toBe('ready');
        expect(session.viewportSession.value).toMatchObject({
            lifecycle: 'failed',
            requestedPage: 5,
            skeletonDelay: null,
            failure: 'Native preview failed',
            visual: {
                kind: 'page',
                pageNumber: 5,
                presentation: 'error',
                error: 'Native preview failed',
            },
        });
        expect(session.failPageTransition(4, 'stale')).toBe(false);
        vi.useRealTimers();
    });

    it('generation-fences the replacement page shell until its joined commit', () => {
        const session = createDocumentOpenSurfaceSession();
        const firstGeneration = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        session.commitGeometry(firstGeneration, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const firstFence = session.createRenderFence({
            generation: firstGeneration,
            documentRevision: 'rev-a',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        session.commitCanvas(firstFence);
        session.commitViewport(createViewportCommit(firstFence));
        expect(session.markReady(firstFence)).toBe(true);

        const secondGeneration = session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b',
        }, {
            documentId: 'b.pdf',
            pageNumber: 1,
            pageCount: 2,
            width: 700,
            height: 900,
            rotation: 0,
        });
        expect(session.commitOpeningPageFrame(secondGeneration, {
            generation: secondGeneration,
            ownerId: 'pdfjs',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '700px',
                height: '900px',
            },
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');

        const supersededGeneration = session.supersede()!;
        expect(session.snapshot.value.presentation).toBe('idle');
        expect(session.snapshot.value.openingPageFrame).toBeNull();
        session.commitGeometry(supersededGeneration, {
            width: 700,
            height: 900,
            margin: 20,
        });
        const replacementFence = session.createRenderFence({
            generation: supersededGeneration,
            documentRevision: 'rev-b',
            renderVersion: 2,
            requestId: 3,
            pageNumber: 1,
        })!;
        session.commitCanvas(replacementFence);
        session.commitViewport(createViewportCommit(replacementFence));

        expect(session.markReady(replacementFence)).toBe(true);
        expect(session.snapshot.value).toMatchObject({
            phase: 'ready',
            presentation: 'committed',
        });
    });

    it('does not expose an empty-to-document page shell before frame and geometry commit', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });

        expect(session.snapshot.value).toMatchObject({presentation: 'idle'});
        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'pdfjs',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '612px',
                height: '792px',
            },
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('idle');
        expect(session.commitOpeningPageGeometry(generation, {
            documentId: 'a.pdf',
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');
        expect(session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');
    });

    it('presents an exact opening shell when its frame arrives after opening geometry', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        }, {
            documentId: 'a.pdf',
            pageNumber: 7,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
        });

        expect(session.snapshot.value.presentation).toBe('idle');
        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'pdfjs',
            pageNumber: 7,
            intentKey: 'fit-width:1',
            style: {
                width: '612px',
                height: '792px',
            },
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');
        expect(session.snapshot.value.geometry).toBeNull();
    });

    it('atomically begins a prepared empty-surface open without exposing pending idle', () => {
        const session = createDocumentOpenSurfaceSession();
        const snapshots: Array<{
            phase: string;
            presentation: string;
        }> = [];
        watch(session.snapshot, value => snapshots.push({
            phase: value.phase,
            presentation: value.presentation,
        }), {flush: 'sync'});

        const generation = session.beginPrepared({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:prepared',
        }, {
            documentId: 'scan.pdf',
            ownerId: 'document-viewer-chassis:1',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '0:1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: '28000000:42',
            style: {
                width: '960px',
                height: '1280px',
            },
            geometry: {
                documentId: 'scan.pdf',
                pageNumber: 1,
                pageCount: 431,
                width: 600,
                height: 800,
                rotation: 0,
            },
        });

        expect(generation).toBe(1);
        expect(snapshots).toEqual([{
            phase: 'pending',
            presentation: 'page-shell',
        }]);
        expect(session.snapshot.value).toMatchObject({
            phase: 'pending',
            presentation: 'page-shell',
            openingPageGeometry: {documentId: 'scan.pdf'},
            openingPageFrame: {
                generation: 1,
                ownerId: 'document-viewer-chassis:1',
            },
        });
    });

    it('keeps one page-shell owner while the PDF loader promotes its revision', () => {
        const session = createDocumentOpenSurfaceSession();
        const presentations: string[] = [];
        watch(session.snapshot, value => presentations.push(value.presentation), {flush: 'sync'});
        const generation = session.beginPrepared({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:prepared',
        }, {
            documentId: 'scan.pdf',
            ownerId: 'document-viewer-chassis:1',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '0:1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: '28000000:42',
            style: {
                width: '960px',
                height: '1280px',
            },
            geometry: {
                documentId: 'scan.pdf',
                pageNumber: 1,
                pageCount: 431,
                width: 600,
                height: 800,
                rotation: 0,
            },
        })!;

        expect(session.claim({
            documentId: 'scan.pdf',
            documentRevision: 'pdf-source:42',
        })).toBe(generation);
        expect(session.snapshot.value).toMatchObject({
            generation,
            presentation: 'page-shell',
            identity: {documentRevision: 'pdf-source:42'},
            openingPageFrame: {
                generation,
                ownerId: 'document-viewer-chassis:1',
            },
        });
        expect(session.clearOpeningPageFrame(generation, 'document-viewer-chassis:1')).toBe(false);
        expect(presentations).toEqual([
            'page-shell',
            'page-shell',
        ]);
    });

    it('rejects a mismatched prepared frame without changing the empty surface', () => {
        const session = createDocumentOpenSurfaceSession();
        expect(session.beginPrepared({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:prepared',
        }, {
            documentId: 'other.pdf',
            ownerId: 'document-viewer-chassis:1',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            layoutKey: '0:1000x800',
            policyKey: 'width:single:fit-width:1',
            sourceRevisionKey: '28000000:42',
            style: {width: '960px'},
            geometry: {
                documentId: 'other.pdf',
                pageNumber: 1,
                pageCount: 1,
                width: 600,
                height: 800,
                rotation: 0,
            },
        })).toBeNull();
        expect(session.snapshot.value).toMatchObject({
            phase: 'idle',
            presentation: 'idle',
            identity: null,
        });
    });

    it('does not present an opening frame for a different page', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        }, {
            documentId: 'a.pdf',
            pageNumber: 7,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 0,
        });

        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'pdfjs',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '612px',
                height: '792px',
            },
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('idle');
    });

    it('makes the opening surface the sole owner of empty-placeholder handoff', () => {
        const session = createDocumentOpenSurfaceSession();
        expect(shouldPresentDocumentOpenEmptyPlaceholder(session.snapshot.value)).toBe(true);

        const generation = session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });
        expect(shouldPresentDocumentOpenEmptyPlaceholder(session.snapshot.value)).toBe(true);

        session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'pdfjs',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '760px',
                height: '1224px',
            },
        });
        expect(shouldPresentDocumentOpenEmptyPlaceholder(session.snapshot.value)).toBe(true);

        session.commitGeometry(generation, {
            width: 760,
            height: 1224,
            margin: 20,
        });
        expect(shouldPresentDocumentOpenEmptyPlaceholder(session.snapshot.value)).toBe(false);

        const failedSession = createDocumentOpenSurfaceSession();
        const failedGeneration = failedSession.begin({
            documentId: 'broken.pdf',
            documentRevision: 'open-intent:2',
        });
        failedSession.fail(failedGeneration, 'load failed');
        expect(shouldPresentDocumentOpenEmptyPlaceholder(failedSession.snapshot.value)).toBe(false);

        failedSession.reset();
        expect(shouldPresentDocumentOpenEmptyPlaceholder(failedSession.snapshot.value)).toBe(true);
    });

    it('owns and generation-fences the exact opening page frame', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });
        const style = {
            width: '612px',
            height: '792px',
        };

        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'pdfjs',
            pageNumber: 7,
            intentKey: 'custom:3.92',
            style,
        })).toBe(true);
        style.width = '1px';
        expect(session.snapshot.value.openingPageFrame).toMatchObject({
            generation,
            pageNumber: 7,
            intentKey: 'custom:3.92',
            style: {
                width: '612px',
                height: '792px',
            },
        });

        const nextGeneration = session.supersede()!;
        expect(session.snapshot.value.openingPageFrame).toBeNull();
        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'pdfjs',
            pageNumber: 7,
            intentKey: 'custom:3.92',
            style,
        })).toBe(false);
        expect(nextGeneration).toBe(generation + 1);
    });

    it('prevents one renderer from clearing or overwriting another renderer frame', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.djvu',
            documentRevision: 'open-intent:1',
        });
        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'page-source:1',
            pageNumber: 1,
            intentKey: 'page-source:fit-width:1',
            style: {
                width: '612px',
                height: '792px',
            },
        })).toBe(true);
        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'pdfjs',
            pageNumber: 1,
            intentKey: 'fit-width:1',
            style: {
                width: '1px',
                height: '1px',
            },
        })).toBe(false);
        expect(session.clearOpeningPageFrame(generation, 'pdfjs')).toBe(false);
        expect(session.clearOpeningPageFrame(generation, 'page-source:1')).toBe(false);
        expect(session.snapshot.value.openingPageFrame?.ownerId).toBe('page-source:1');
    });

    it('presents the canonical shell when its owned frame arrives after geometry', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.djvu',
            documentRevision: 'open-intent:1',
        });
        expect(session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('idle');
        expect(session.commitOpeningPageFrame(generation, {
            generation,
            ownerId: 'page-source:1',
            pageNumber: 1,
            intentKey: 'page-source:fit-width:1',
            style: {
                width: '612px',
                height: '792px',
            },
        })).toBe(true);
        expect(session.snapshot.value.presentation).toBe('page-shell');
    });

    it('restarts a failed replacement through the empty page-shell surface', () => {
        const session = createDocumentOpenSurfaceSession();
        const initialGeneration = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        session.commitGeometry(initialGeneration, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const initialFence = session.createRenderFence({
            generation: initialGeneration,
            documentRevision: 'rev-a',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        session.commitCanvas(initialFence);
        session.commitViewport(createViewportCommit(initialFence));
        session.markReady(initialFence);

        const failedGeneration = session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b',
        });
        expect(session.fail(failedGeneration, 'load failed')).toBe(true);
        const retryGeneration = session.begin({
            documentId: 'b.pdf',
            documentRevision: 'rev-b:retry',
        });

        expect(session.snapshot.value).toMatchObject({
            generation: retryGeneration,
            phase: 'pending',
            presentation: 'idle',
        });
    });

    it('rejects older requests after a newer canvas has committed', () => {
        const session = createDocumentOpenSurfaceSession();
        session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        const generation = session.snapshot.value.generation;
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const newer = session.createRenderFence({
            generation,
            documentRevision: 'rev-a',
            renderVersion: 4,
            requestId: 10,
            pageNumber: 1,
        })!;
        const older = {
            ...newer,
            requestId: 9,
        };

        expect(session.commitCanvas(newer)).toBe(true);
        expect(session.commitCanvas(older)).toBe(false);
        expect(session.snapshot.value.committedRender).toBe(newer);
    });

    it('does not replace a current-generation canvas commit with a late failure', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const fence = session.createRenderFence({
            generation,
            documentRevision: 'rev-a',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        expect(session.commitCanvas(fence)).toBe(true);

        expect(session.fail(generation, 'late recovery failure')).toBe(false);
        expect(session.snapshot.value.phase).toBe('canvas-committed');
        expect(session.snapshot.value.failure).toBeNull();
    });

    it('supersedes an in-flight render when viewport intent changes', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        const fence = session.createRenderFence({
            generation,
            documentRevision: 'rev-a',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;

        expect(session.supersede()).toBe(2);
        expect(session.commitCanvas(fence)).toBe(false);
        expect(session.snapshot.value.phase).toBe('pending');
    });

    it('does not accept guessed or invalid geometry', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });

        expect(session.commitGeometry(generation, {
            width: 0,
            height: 792,
            margin: 20,
        })).toBe(false);
        expect(session.snapshot.value.geometry).toBeNull();
        expect(session.snapshot.value.phase).toBe('pending');
    });

    it('reserves a stable gutter and enables legitimate overflow only after an exact commit', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        expect(resolveDocumentOpenSurfaceViewportPolicy(session.snapshot.value)).toEqual({
            overflow: 'hidden',
            scrollbarGutter: 'stable',
            committedMargin: null,
        });
        session.commitGeometry(generation, {
            width: 3_060,
            height: 3_960,
            margin: 20,
        });
        const fence = session.createRenderFence({
            generation,
            documentRevision: 'rev-a',
            renderVersion: 2,
            requestId: 3,
            pageNumber: 1,
        })!;
        session.commitCanvas(fence);
        session.commitViewport(createViewportCommit(fence));
        session.markReady(fence);

        expect(resolveDocumentOpenSurfaceViewportPolicy(session.snapshot.value)).toEqual({
            overflow: 'auto',
            scrollbarGutter: 'stable',
            committedMargin: 20,
        });
    });

    it('projects scroll position only from a fully committed viewport session', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'scan.djvu',
            documentRevision: 'revision-1',
        });
        expect(shouldProjectDocumentViewportScroll(
            session.snapshot.value,
            session.viewportSession.value,
        )).toBe(false);

        session.commitOpeningPageGeometry(generation, {
            documentId: 'scan.djvu',
            pageNumber: 1,
            pageCount: 20,
            width: 612,
            height: 792,
            rotation: 0,
        });
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 16,
        });
        const fence = session.createRenderFence({
            generation,
            documentRevision: 'revision-1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        session.commitCanvas(fence);
        session.commitViewport(createViewportCommit(fence));
        session.markReady(fence);

        expect(shouldProjectDocumentViewportScroll(
            session.snapshot.value,
            session.viewportSession.value,
        )).toBe(true);

        session.requestNavigation(2);
        expect(shouldProjectDocumentViewportScroll(
            session.snapshot.value,
            session.viewportSession.value,
        )).toBe(false);
    });

    it('keeps animation-frame sampling monotonic across same-turn DOM mutations', async () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'a.pdf',
            documentRevision: 'rev-a',
        });
        const sampledPhases = [session.snapshot.value.phase];
        await Promise.resolve().then(() => {
            session.commitGeometry(generation, {
                width: 612,
                height: 792,
                margin: 20,
            });
            const fence = session.createRenderFence({
                generation,
                documentRevision: 'rev-a',
                renderVersion: 1,
                requestId: 1,
                pageNumber: 1,
            })!;
            session.commitCanvas(fence);
            session.commitViewport(createViewportCommit(fence));
            session.markReady(fence);
        });
        sampledPhases.push(session.snapshot.value.phase);

        expect(sampledPhases).toEqual([
            'pending',
            'ready',
        ]);
        expect(session.snapshot.value.committedRender?.requestId).toBe(1);
    });

    it('accepts a late valid canvas from the failed generation and clears its failure', () => {
        const session = createDocumentOpenSurfaceSession();
        const generation = session.begin({
            documentId: 'slow-scan.pdf',
            documentRevision: 'rev-1',
        });
        session.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        });
        session.fail(generation, 'initial render recovery exhausted');

        const fence = session.createRenderFence({
            generation,
            documentRevision: 'rev-1',
            renderVersion: 1,
            requestId: 9,
            pageNumber: 1,
        });

        expect(fence).not.toBeNull();
        expect(session.commitCanvas(fence!)).toBe(true);
        expect(session.commitViewport(createViewportCommit(fence!))).toBe(true);
        expect(session.markReady(fence!)).toBe(true);
        expect(session.snapshot.value).toMatchObject({
            generation,
            phase: 'ready',
            failure: null,
        });
    });

    it('rejects a late success from a superseded failed generation', () => {
        const session = createDocumentOpenSurfaceSession();
        const failedGeneration = session.begin({
            documentId: 'old.pdf',
            documentRevision: 'old-rev',
        });
        session.commitGeometry(failedGeneration, {
            width: 612,
            height: 792,
            margin: 20,
        });
        session.fail(failedGeneration, 'old failure');
        session.begin({
            documentId: 'new.pdf',
            documentRevision: 'new-rev',
        });

        expect(session.createRenderFence({
            generation: failedGeneration,
            documentRevision: 'old-rev',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })).toBeNull();
    });
});
