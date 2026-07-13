import { viewportSimulation } from '@tests/helpers/viewer-core/viewportSimulation';

export function replayGirgas55To56() {
    const simulation = new viewportSimulation();
    simulation.setPageTop(55, 54_000);
    simulation.setPageTop(56, 55_000);
    simulation.transitionVisual(55, 1, 'ready');
    const intent = simulation.beginIntent('wheel-page', 56);
    simulation.schedule(intent, 'canvas', () => simulation.transitionVisual(56, 1, 'ready'));
    simulation.schedule(intent, 'scroll', () => simulation.applyScroll(intent, 55_000, 'exact-page-top'));
    simulation.flush([
        'canvas',
        'scroll',
    ]);
    simulation.settle(intent);
    return simulation;
}

export function replayToolbarJumpTo500WithLateMetrics() {
    const simulation = new viewportSimulation();
    simulation.setAnchor({
        page: 500,
        pageYFraction: 0.25,
        viewportYFraction: 0.5,
    });
    simulation.setPageTop(1, 0);
    const intent = simulation.beginIntent('toolbar', 500);
    simulation.demandPages([
        1,
        2,
    ], [
        499,
        500,
        501,
    ], [1], [
        2,
        3,
        1,
    ]);
    simulation.correctGeometry(new Map([[
        500,
        499_000,
    ]]), 1_200, 800);
    simulation.transitionVisual(500, 1, 'ready');
    simulation.applyScroll(intent, simulation.scrollTop, 'late-metrics-anchor');
    simulation.settle(intent);
    return simulation;
}

export function replayRapidOneToThirtyToLast() {
    const simulation = new viewportSimulation();
    simulation.setPageTop(928, 927_000);
    const first = simulation.beginIntent('navigate', 1);
    simulation.schedule(first, 'late-first', () => simulation.applyScroll(first, 0, 'stale-first'));
    const thirty = simulation.beginIntent('navigate', 30);
    simulation.schedule(thirty, 'late-thirty', () => simulation.applyScroll(thirty, 29_000, 'stale-thirty'));
    const last = simulation.beginIntent('navigate', 928);
    simulation.schedule(last, 'last', () => {
        simulation.transitionVisual(928, 1, 'ready');
        simulation.applyScroll(last, 927_000, 'latest-last');
    });
    simulation.flush([
        'late-thirty',
        'last',
        'late-first',
    ]);
    simulation.settle(last);
    return simulation;
}
