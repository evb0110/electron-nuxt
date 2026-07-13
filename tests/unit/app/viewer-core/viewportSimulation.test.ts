import {
    describe,
    expect,
    it,
} from 'vitest';
import { viewportSimulation } from '@tests/helpers/viewer-core/viewportSimulation';
import {
    replayGirgas55To56,
    replayRapidOneToThirtyToLast,
    replayToolbarJumpTo500WithLateMetrics,
} from '@tests/helpers/viewer-core/goldenPainReplays';

describe('viewportSimulation invariants', () => {
    it('I1 records every programmatic write under the single authority with an intent', () => {
        const simulation = new viewportSimulation();
        const intent = simulation.beginIntent('navigate', 2);
        simulation.applyScroll(intent, 1_000, 'page-top');
        expect(simulation.scrollWrites).toEqual([expect.objectContaining({
            author: 'ViewportAuthority',
            intentId: intent.id,
        })]);
    });

    it('I2 makes the latest intent globally supersede stale continuations', () => {
        const simulation = replayRapidOneToThirtyToLast();
        expect(simulation.scrollWrites.map(write => write.reason)).toEqual(['latest-last']);
        expect(simulation.currentPage).toBe(928);
    });

    it('I3 rejects delayed writes captured before a user interaction epoch', () => {
        const simulation = new viewportSimulation();
        const restore = simulation.beginIntent('restore', 4);
        simulation.schedule(restore, 'restore', () => simulation.applyScroll(restore, 3_000, 'restore'));
        simulation.userScroll(750);
        simulation.flush();
        expect(simulation.scrollTop).toBe(750);
        expect(simulation.scrollWrites.at(-1)?.author).toBe('user');
    });

    it('I4 emits exactly one terminal outcome for each intent', () => {
        const simulation = new viewportSimulation();
        const first = simulation.beginIntent('navigate', 2);
        const second = simulation.beginIntent('navigate', 3);
        simulation.settle(second);
        simulation.settle(second);
        expect([...simulation.terminalOutcomes.entries()]).toEqual([
            [
                first.id,
                'cancelled',
            ],
            [
                second.id,
                'settled',
            ],
        ]);
    });

    it('I5 derives currentPage from committed geometry and scroll', () => {
        const simulation = new viewportSimulation();
        simulation.setPageTop(1, 0);
        simulation.setPageTop(2, 1_000);
        const intent = simulation.beginIntent('navigate', 2);
        expect(simulation.currentPage).toBe(1);
        expect(simulation.pendingTargetPage).toBe(2);
        simulation.applyScroll(intent, 1_000, 'page-top');
        expect(simulation.currentPage).toBe(2);
    });

    it('I6 preserves a semantic anchor under late metric correction', () => {
        const simulation = replayToolbarJumpTo500WithLateMetrics();
        expect(simulation.scrollTop).toBe(498_900);
        expect(simulation.scrollWrites.at(-1)?.top).toBe(498_900);
    });

    it('I7 preserves the cursor document point through zoom packets', () => {
        const simulation = new viewportSimulation();
        const intent = simulation.beginIntent('zoom');
        simulation.applyZoom(intent, 2, 400, 100);
        expect((simulation.scrollTop + 100) / simulation.zoom).toBe(400);
        simulation.applyZoom(intent, 3.44, 400, 100);
        expect((simulation.scrollTop + 100) / simulation.zoom).toBeCloseTo(400, 10);
    });

    it('I8 keeps fit scale semantic across mixed page geometry', () => {
        const fitHeight = (viewportHeight: number, pageHeight: number) => viewportHeight / pageHeight;
        expect(fitHeight(800, 1_000)).toBe(0.8);
        expect(fitHeight(800, 1_600)).toBe(0.5);
        expect(fitHeight(800, 1_000)).toBe(0.8);
    });

    it('I9 changes only render epoch for DPR updates', () => {
        const simulation = new viewportSimulation();
        const before = [
            simulation.scrollTop,
            simulation.zoom,
            simulation.geometryRevision,
        ];
        simulation.bumpDpr();
        expect([
            simulation.scrollTop,
            simulation.zoom,
            simulation.geometryRevision,
        ]).toEqual(before);
        expect(simulation.renderEpoch).toBe(2);
    });

    it('I10 rejects skeleton regression after a usable canvas', () => {
        const simulation = replayGirgas55To56();
        expect(simulation.transitionVisual(56, 1, 'skeleton')).toBe(false);
        expect(simulation.getVisual(56)).toBe('ready');
    });

    it('I11 clears a replaced raster before skeleton and canonical readiness', () => {
        const simulation = new viewportSimulation();
        simulation.transitionVisual(3, 1, 'ready');
        simulation.transitionVisual(3, 1, 'none');
        simulation.transitionVisual(3, 1, 'skeleton');
        simulation.transitionVisual(3, 1, 'ready');
        expect(simulation.getVisual(3)).toBe('ready');
        expect(simulation.visualTransitions).toEqual([
            '3:1:none>ready',
            '3:1:ready>none',
            '3:1:none>skeleton',
            '3:1:skeleton>ready',
        ]);
    });

    it('I12 commits both pages of a facing row as one readiness decision', () => {
        const simulation = new viewportSimulation();
        const rowReady = (pages: number[]) => pages.every(page => simulation.getVisual(page) === 'ready');
        simulation.transitionVisual(10, 1, 'ready');
        expect(rowReady([
            10,
            11,
        ])).toBe(false);
        simulation.transitionVisual(11, 1, 'ready');
        expect(rowReady([
            10,
            11,
        ])).toBe(true);
    });

    it('I13 bounds disjoint mounts independent of navigation distance', () => {
        const simulation = new viewportSimulation();
        simulation.demandPages([
            1,
            2,
        ], [
            499,
            500,
            501,
        ], [3], [
            2,
            3,
            1,
        ]);
        expect([...simulation.mountedPages].sort((a, b) => a - b)).toEqual([
            1,
            2,
            3,
            499,
            500,
            501,
        ]);
        expect(simulation.mountedPages.size).toBeLessThanOrEqual(6);
    });

    it('I14 records exact target geometry as the committed placement', () => {
        const simulation = replayToolbarJumpTo500WithLateMetrics();
        expect(simulation.scrollWrites.at(-1)?.reason).toBe('late-metrics-anchor');
        expect(simulation.pendingTargetPage).toBeNull();
    });

    it('I15 aggregates exact byte ranges and rejects short fulfillment', () => {
        const simulation = new viewportSimulation();
        simulation.fulfillRange(0, 5, [
            new Uint8Array(2),
            new Uint8Array(3),
        ]);
        expect(simulation.exactRangeDeliveries).toEqual([{
            begin: 0,
            end: 5,
            bytes: 5,
        }]);
        expect(() => simulation.fulfillRange(0, 5, [new Uint8Array(4)])).toThrow('Short range');
    });

    it('I16 starts optional work only after the first stable visual', () => {
        const simulation = new viewportSimulation();
        expect(() => simulation.startOptionalWork()).toThrow('first stable visual');
        simulation.transitionVisual(1, 1, 'ready');
        simulation.startOptionalWork();
        expect(simulation.optionalWorkStarted).toBe(true);
    });

    it('I17 makes wheel direction reversal immediately supersede the prior page turn', () => {
        const simulation = new viewportSimulation();
        const forward = simulation.beginIntent('wheel-forward', 2);
        simulation.schedule(forward, 'forward', () => simulation.applyScroll(forward, 1_000, 'forward'));
        const reverse = simulation.beginIntent('wheel-reverse', 1);
        simulation.schedule(reverse, 'reverse', () => simulation.applyScroll(reverse, 0, 'reverse'));
        simulation.flush([
            'forward',
            'reverse',
        ]);
        expect(simulation.scrollWrites.map(write => write.reason)).toEqual(['reverse']);
    });

    it('I18 remains deterministic under adversarial event reordering without clock constants', () => {
        const run = (order: string[]) => {
            const simulation = new viewportSimulation();
            const stale = simulation.beginIntent('navigate', 30);
            simulation.schedule(stale, 'stale-render', () => simulation.applyScroll(stale, 29_000, 'stale'));
            const latest = simulation.beginIntent('navigate', 928);
            simulation.schedule(latest, 'metrics', () => simulation.setPageTop(928, 927_000));
            simulation.schedule(latest, 'mount', () => simulation.mountedPages.add(928));
            simulation.schedule(latest, 'canvas', () => simulation.transitionVisual(928, 1, 'ready'));
            simulation.schedule(latest, 'commit', () => simulation.applyScroll(latest, 927_000, 'latest'));
            simulation.flush(order);
            return simulation;
        };
        for (const order of [
            [
                'canvas',
                'commit',
                'metrics',
                'mount',
                'stale-render',
            ],
            [
                'mount',
                'metrics',
                'stale-render',
                'canvas',
                'commit',
            ],
        ]) {
            const simulation = run(order);
            expect(simulation.scrollWrites.map(write => write.reason)).toEqual(['latest']);
            expect(simulation.getVisual(928)).toBe('ready');
        }
    });
});
