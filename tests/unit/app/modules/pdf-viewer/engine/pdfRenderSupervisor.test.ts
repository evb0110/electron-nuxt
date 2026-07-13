import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisorEvent,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';

describe('pdf render supervisor', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('classifies page-stage timeout causes without changing the stall payload', async () => {
        vi.useFakeTimers();
        const events: IPdfRenderSupervisorEvent[] = [];
        const supervisor = createPdfRenderSupervisor({
            now: () => 123,
            onEvent: event => events.push(event),
        });
        const onRenderStall = vi.fn();
        const stalledPromise = withPageStageTimeout(
            new Promise<never>(() => {}),
            {
                pageNumber: 7,
                stage: 'canvas-render',
                timeoutMs: 25,
            },
            () => true,
            undefined,
            onRenderStall,
            supervisor,
        );

        const rejection = expect(stalledPromise).rejects.toMatchObject({
            pageNumber: 7,
            stage: 'canvas-render',
            timeoutMs: 25,
        });

        await vi.advanceTimersByTimeAsync(25);
        await rejection;

        expect(onRenderStall).toHaveBeenCalledExactlyOnceWith({
            pageNumber: 7,
            stage: 'canvas-render',
            timeoutMs: 25,
        });
        expect(events).toContainEqual(expect.objectContaining({
            cause: 'page-stage-timeout',
            delayMs: 25,
            metadata: {
                pageNumber: 7,
                stage: 'canvas-render',
                timeoutMs: 25,
            },
        }));
    });

    it('clears a page-stage watchdog when its render lifecycle is aborted', async () => {
        vi.useFakeTimers();
        const events: IPdfRenderSupervisorEvent[] = [];
        const supervisor = createPdfRenderSupervisor({onEvent: event => events.push(event)});
        const controller = new AbortController();
        const stalledPromise = withPageStageTimeout(
            new Promise<never>(() => {}),
            {
                pageNumber: 1,
                stage: 'text-layer',
                timeoutMs: 15_000,
            },
            () => true,
            undefined,
            undefined,
            supervisor,
            controller.signal,
        );

        controller.abort();
        await expect(stalledPromise).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(15_000);

        expect(events).toEqual([]);
    });

    it('drops superseded watchdog callbacks before they can run recovery', () => {
        const callbacks: Array<() => void> = [];
        const events: IPdfRenderSupervisorEvent[] = [];
        const handles: Array<ReturnType<typeof setTimeout>> = [];
        const firstRecovery = vi.fn();
        const secondRecovery = vi.fn();
        const supervisor = createPdfRenderSupervisor({
            clearTimeoutFn: handle => clearTimeout(handle),
            now: () => 456,
            onEvent: event => events.push(event),
            setTimeoutFn: (callback, delayMs) => {
                callbacks.push(callback);
                const handle = setTimeout(() => {}, delayMs);
                handles.push(handle);
                return handle;
            },
        });

        supervisor.armTimer({
            cause: 'navigation-hold-recovery',
            delayMs: 10,
            key: 'navigation-hold-recovery',
            onFire: firstRecovery,
        });
        supervisor.armTimer({
            cause: 'navigation-hold-abandon',
            delayMs: 20,
            key: 'navigation-hold-recovery',
            onFire: secondRecovery,
        });

        callbacks[0]?.();

        expect(firstRecovery).not.toHaveBeenCalled();
        expect(secondRecovery).not.toHaveBeenCalled();
        expect(events).toContainEqual(expect.objectContaining({
            cause: 'stale-superseded',
            sourceCause: 'navigation-hold-recovery',
            ownerKey: 'navigation-hold-recovery',
        }));

        callbacks[1]?.();

        expect(firstRecovery).not.toHaveBeenCalled();
        expect(secondRecovery).toHaveBeenCalledOnce();
        expect(events).toContainEqual(expect.objectContaining({
            cause: 'navigation-hold-abandon',
            ownerKey: 'navigation-hold-recovery',
        }));
        handles.forEach(handle => clearTimeout(handle));
    });

    it('reports explicit annotation editor layer events without arming timers', () => {
        const events: IPdfRenderSupervisorEvent[] = [];
        const supervisor = createPdfRenderSupervisor({
            now: () => 789,
            onEvent: event => events.push(event),
        });

        const event = supervisor.reportEvent({
            cause: 'annotation-editor-layer-render-failed',
            key: 'annotation-editor-layer:3',
            metadata: {
                pageNumber: 3,
                retryable: true,
            },
        });

        expect(event).toMatchObject({
            cause: 'annotation-editor-layer-render-failed',
            delayMs: 0,
            firedAtMs: 789,
            ownerKey: 'annotation-editor-layer:3',
            metadata: {
                pageNumber: 3,
                retryable: true,
            },
        });
        expect(events).toEqual([event]);
    });
});
