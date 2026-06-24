import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { nextTick } from 'vue';
import { createNavigationSettleEffects } from '@app/modules/pdf-viewer/runtime/navigation/createNavigationSettleEffects';

describe('createNavigationSettleEffects', () => {
    it('reapplies mutation-driven continuous navigation layout synchronously', () => {
        const onLayoutReapply = vi.fn();
        const effects = createNavigationSettleEffects({
            getLayoutObserverElements: () => [],
            hasLayoutMutation: () => false,
            onLayoutReapply,
        });
        const markerRect = {
            left: 0.11,
            top: 0.22,
            width: 0.33,
            height: 0.44,
        };

        effects.scheduleLayoutReapply(7, 165, 'mutation', { markerRect });

        expect(onLayoutReapply).toHaveBeenCalledExactlyOnceWith({
            pageNumber: 165,
            reason: 'mutation',
            runId: 7,
            scrollOptions: { markerRect },
        });
    });

    it('reapplies resize-driven continuous navigation layout synchronously', () => {
        const onLayoutReapply = vi.fn();
        const effects = createNavigationSettleEffects({
            getLayoutObserverElements: () => [],
            hasLayoutMutation: () => false,
            onLayoutReapply,
        });

        effects.scheduleLayoutReapply(3, 97, 'resize');

        expect(onLayoutReapply).toHaveBeenCalledExactlyOnceWith({
            pageNumber: 97,
            reason: 'resize',
            runId: 3,
            scrollOptions: undefined,
        });
    });

    it('coalesces scroll-driven continuous navigation layout reapply until next tick', async () => {
        const onLayoutReapply = vi.fn();
        const effects = createNavigationSettleEffects({
            getLayoutObserverElements: () => [],
            hasLayoutMutation: () => false,
            onLayoutReapply,
        });

        effects.scheduleLayoutReapply(3, 97, 'scroll');
        effects.scheduleLayoutReapply(3, 97, 'scroll');

        expect(onLayoutReapply).not.toHaveBeenCalled();

        await nextTick();

        expect(onLayoutReapply).toHaveBeenCalledExactlyOnceWith({
            pageNumber: 97,
            reason: 'scroll',
            runId: 3,
            scrollOptions: undefined,
        });
    });

    it('flushes mutation reapply immediately when it supersedes a queued scroll reapply', async () => {
        const onLayoutReapply = vi.fn();
        const effects = createNavigationSettleEffects({
            getLayoutObserverElements: () => [],
            hasLayoutMutation: () => false,
            onLayoutReapply,
        });
        const markerRect = {
            left: 0.11,
            top: 0.22,
            width: 0.33,
            height: 0.44,
        };

        effects.scheduleLayoutReapply(3, 97, 'scroll');
        effects.scheduleLayoutReapply(4, 98, 'mutation', { markerRect });

        expect(onLayoutReapply).toHaveBeenCalledExactlyOnceWith({
            pageNumber: 98,
            reason: 'mutation',
            runId: 4,
            scrollOptions: { markerRect },
        });

        await nextTick();

        expect(onLayoutReapply).toHaveBeenCalledTimes(1);
    });

    it('runs paged hold watchdog callbacks on their configured timers', () => {
        vi.useFakeTimers();
        try {
            const events: string[] = [];
            const effects = createNavigationSettleEffects({
                getLayoutObserverElements: () => [],
                hasLayoutMutation: () => false,
                onLayoutReapply: vi.fn(),
            });

            effects.armPagedHoldWatchdog({
                runId: 11,
                targetPage: 4,
                readyRetryDelaysMs: [
                    10,
                    20,
                ],
                recoveryRenderMs: 30,
                abandonMs: 40,
                stallLogMs: 50,
                onReadyRetry: event => events.push(`ready:${event.runId}:${event.targetPage}:${event.delayMs}`),
                onRecovery: event => events.push(`recovery:${event.runId}:${event.targetPage}:${event.delayMs}`),
                onAbandon: event => events.push(`abandon:${event.runId}:${event.targetPage}:${event.delayMs}`),
                onStillWaiting: event => events.push(`waiting:${event.runId}:${event.targetPage}:${event.delayMs}`),
            });

            vi.advanceTimersByTime(9);
            expect(events).toEqual([]);

            vi.advanceTimersByTime(1);
            expect(events).toEqual(['ready:11:4:10']);

            vi.advanceTimersByTime(10);
            expect(events).toEqual([
                'ready:11:4:10',
                'ready:11:4:20',
            ]);

            vi.advanceTimersByTime(30);
            expect(events).toEqual([
                'ready:11:4:10',
                'ready:11:4:20',
                'recovery:11:4:30',
                'abandon:11:4:40',
                'waiting:11:4:50',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears and replaces paged hold watchdog timers as one actor', () => {
        vi.useFakeTimers();
        try {
            const events: string[] = [];
            const effects = createNavigationSettleEffects({
                getLayoutObserverElements: () => [],
                hasLayoutMutation: () => false,
                onLayoutReapply: vi.fn(),
            });
            const armWatchdog = (runId: number) => effects.armPagedHoldWatchdog({
                runId,
                targetPage: runId + 1,
                readyRetryDelaysMs: [10],
                recoveryRenderMs: 20,
                abandonMs: 30,
                stallLogMs: 40,
                onReadyRetry: event => events.push(`ready:${event.runId}`),
                onRecovery: event => events.push(`recovery:${event.runId}`),
                onAbandon: event => events.push(`abandon:${event.runId}`),
                onStillWaiting: event => events.push(`waiting:${event.runId}`),
            });

            armWatchdog(1);
            effects.clearPagedHoldWatchdog();
            vi.advanceTimersByTime(50);
            expect(events).toEqual([]);

            armWatchdog(2);
            armWatchdog(3);
            vi.advanceTimersByTime(50);

            expect(events).toEqual([
                'ready:3',
                'recovery:3',
                'abandon:3',
                'waiting:3',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });
});
