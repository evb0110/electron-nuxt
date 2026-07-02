import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createPagedNavigationAuthority } from '@app/modules/pdf-viewer/runtime/navigation/createPagedNavigationAuthority';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisorEvent,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';

function createAuthorityHarness(options?: { onSupervisorEvent?: ((event: IPdfRenderSupervisorEvent) => void) | undefined; }) {
    let now = 100;
    const emittedFeedbackPages: Array<number | null> = [];
    const armHoldWatchdog = vi.fn();
    const clearHoldWatchdog = vi.fn();
    const renderSupervisor = options?.onSupervisorEvent
        ? createPdfRenderSupervisor({ onEvent: options.onSupervisorEvent })
        : undefined;
    const authority = createPagedNavigationAuthority({
        armHoldWatchdog,
        clearHoldWatchdog,
        emitNavigationFeedbackPage: page => emittedFeedbackPages.push(page),
        getFeedbackTraceContext: () => ({
            currentPage: 1,
            pagedNavigationTargetPage: 2,
        }),
        now: () => now,
        renderSupervisor,
    });

    const setNow = (nextNow: number) => {
        now = nextNow;
    };

    const startHold = (runId: number, targetPage: number) => authority.startHold({
        runId,
        targetPage,
        targetStart: targetPage,
        targetEnd: targetPage + 1,
        readyRetryDelaysMs: [10],
        recoveryRenderMs: 20,
        abandonMs: 30,
        stallLogMs: 40,
        onReadyRetry: vi.fn(),
        onRecovery: vi.fn(),
        onAbandon: vi.fn(),
        onStillWaiting: vi.fn(),
    });

    return {
        armHoldWatchdog,
        authority,
        clearHoldWatchdog,
        emittedFeedbackPages,
        setNow,
        startHold,
    };
}

describe('paged navigation authority', () => {
    it('starts and replaces a hold through one watchdog owner', () => {
        const {
            armHoldWatchdog,
            authority,
            clearHoldWatchdog,
            setNow,
            startHold,
        } = createAuthorityHarness();

        startHold(1, 2);

        expect(clearHoldWatchdog).toHaveBeenCalledTimes(1);
        expect(authority.hold.value).toEqual({
            expired: false,
            runId: 1,
            startedAtMs: 100,
            targetStart: 2,
            targetEnd: 3,
        });
        expect(armHoldWatchdog).toHaveBeenLastCalledWith(expect.objectContaining({
            runId: 1,
            targetPage: 2,
            readyRetryDelaysMs: [10],
        }));

        setNow(200);
        startHold(2, 4);

        expect(clearHoldWatchdog).toHaveBeenCalledTimes(2);
        expect(authority.isHoldActiveForPage(2)).toBe(false);
        expect(authority.isHoldActiveForPage(4)).toBe(true);
        expect(authority.hold.value).toMatchObject({
            runId: 2,
            startedAtMs: 200,
            targetStart: 4,
            targetEnd: 5,
        });
    });

    it('guards hold clearing and exposes expiry state before cleanup', () => {
        const {
            authority,
            clearHoldWatchdog,
            startHold,
        } = createAuthorityHarness();

        startHold(7, 3);

        expect(authority.clearHold(8)).toBe(false);
        expect(authority.isHoldActiveForPage(3)).toBe(true);
        expect(clearHoldWatchdog).toHaveBeenCalledTimes(1);

        expect(authority.expireHold(8)).toBeNull();
        expect(authority.expireHold(7)).toMatchObject({
            expired: true,
            runId: 7,
        });
        expect(authority.isHoldExpiredPage(3)).toBe(true);

        expect(authority.clearHold(7)).toBe(true);
        expect(authority.isHoldActiveForPage(3)).toBe(false);
        expect(clearHoldWatchdog).toHaveBeenCalledTimes(2);
    });

    it('keeps feedback updates run-scoped and idempotent', () => {
        const {
            authority,
            emittedFeedbackPages,
        } = createAuthorityHarness();

        expect(authority.setFeedbackPage(3, 'started', 11)).toBe(true);
        expect(authority.setFeedbackPage(3, 'duplicate', 11)).toBe(false);
        expect(authority.clearFeedbackPage('wrong-run', 10)).toBe(false);
        expect(authority.getFeedbackState()).toEqual({
            page: 3,
            runId: 11,
        });

        expect(authority.clearFeedbackPage('finished', 11)).toBe(true);
        expect(authority.getFeedbackState()).toEqual({
            page: null,
            runId: null,
        });
        expect(emittedFeedbackPages).toEqual([
            3,
            null,
        ]);
    });

    it('owns target scroll options separately from the host', () => {
        const {authority} = createAuthorityHarness();
        const markerRect = {
            left: 1,
            top: 2,
            width: 3,
            height: 4,
        };

        authority.setTargetScrollOptions({
            markerRect,
            pageYRatio: 0.5,
        });

        expect(authority.getTargetScrollOptions()).toEqual({
            markerRect,
            pageYRatio: 0.5,
        });

        authority.clearTargetScrollOptions();

        expect(authority.getTargetScrollOptions()).toBeUndefined();
    });

    it('owns the programmatic release timer lifecycle without changing release policy', () => {
        vi.useFakeTimers();
        try {
            const supervisorEvents: IPdfRenderSupervisorEvent[] = [];
            const {authority} = createAuthorityHarness({ onSupervisorEvent: event => supervisorEvents.push(event) });
            let active = true;
            let releases = 0;

            authority.scheduleProgrammaticRelease({
                isActive: () => active,
                isDisposed: () => false,
                onRelease: () => {
                    releases += 1;
                    if (releases === 2) {
                        active = false;
                    }
                },
                resolveDelayMs: () => releases === 0 ? 10 : 20,
            });

            expect(authority.hasProgrammaticReleaseTimer()).toBe(true);

            vi.advanceTimersByTime(10);

            expect(releases).toBe(1);
            expect(authority.hasProgrammaticReleaseTimer()).toBe(true);

            vi.advanceTimersByTime(20);

            expect(releases).toBe(2);
            expect(authority.hasProgrammaticReleaseTimer()).toBe(false);
            expect(supervisorEvents.map(event => event.cause)).toEqual([
                'navigation-programmatic-release',
                'navigation-programmatic-release',
            ]);
        } finally {
            vi.useRealTimers();
        }
    });
});
