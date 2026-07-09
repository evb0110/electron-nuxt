import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import {
    createPdfRenderSupervisor,
    type IPdfRenderSupervisor,
    type IPdfRenderSupervisorTimer,
    type TPdfRenderSupervisorWatchdogCause,
} from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

interface IPagedNavigationHold {
    expired: boolean;
    runId: number;
    startedAtMs: number;
    targetStart: number;
    targetEnd: number;
}

interface INavigationFeedbackState {
    page: number | null;
    runId: number | null;
}

interface IPagedNavigationAuthorityTraceContext {
    currentPage: number;
    pagedNavigationTargetPage: number | null;
}

interface IPagedNavigationHoldWatchdogEvent {
    cause: TPdfRenderSupervisorWatchdogCause;
    delayMs: number;
    runId: number;
    targetPage: number;
}

interface IPagedNavigationHoldWatchdogOptions {
    abandonMs: number;
    recoveryRenderMs: number;
    readyRetryDelaysMs: readonly number[];
    stallLogMs: number;
    onAbandon: (event: IPagedNavigationHoldWatchdogEvent) => void;
    onReadyRetry: (event: IPagedNavigationHoldWatchdogEvent) => void;
    onRecovery: (event: IPagedNavigationHoldWatchdogEvent) => void;
    onStillWaiting: (event: IPagedNavigationHoldWatchdogEvent) => void;
}

type TPagedNavigationHoldWatchdogArmOptions = IPagedNavigationHoldWatchdogOptions & {
    runId: number;
    targetPage: number;
};

interface IStartPagedNavigationHoldOptions extends TPagedNavigationHoldWatchdogArmOptions {
    targetEnd: number;
    targetStart: number;
}

interface IScheduleProgrammaticNavigationReleaseOptions {
    isActive: () => boolean;
    isDisposed: () => boolean;
    onRelease: () => void;
    resolveDelayMs: () => number;
}

interface ICreatePagedNavigationAuthorityOptions {
    armHoldWatchdog: (options: TPagedNavigationHoldWatchdogArmOptions) => void;
    clearHoldWatchdog: () => void;
    emitNavigationFeedbackPage?: ((page: number | null) => void) | undefined;
    getFeedbackTraceContext: () => IPagedNavigationAuthorityTraceContext;
    now?: (() => number) | undefined;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
}

type TPagedNavigationTargetScrollOptions =
    | Pick<IScrollToPageOptions, 'pageYRatio' | 'markerRect' | 'preferExactDom'>
    | undefined;

export function createPagedNavigationAuthority(options: ICreatePagedNavigationAuthorityOptions) {
    const renderSupervisor = options.renderSupervisor ?? createPdfRenderSupervisor();
    const hold = shallowRef<IPagedNavigationHold | null>(null);
    let feedbackState: INavigationFeedbackState = {
        page: null,
        runId: null,
    };
    let targetScrollOptions: TPagedNavigationTargetScrollOptions;
    let programmaticReleaseTimer: IPdfRenderSupervisorTimer | null = null;

    function getNow() {
        return options.now?.() ?? Date.now();
    }

    function getFeedbackState() {
        return feedbackState;
    }

    function getTargetScrollOptions() {
        return targetScrollOptions;
    }

    function setTargetScrollOptions(nextTargetScrollOptions: TPagedNavigationTargetScrollOptions) {
        targetScrollOptions = nextTargetScrollOptions;
    }

    function clearTargetScrollOptions() {
        targetScrollOptions = undefined;
    }

    function clearHold(runId?: number) {
        const activeHold = hold.value;
        if (runId !== undefined && activeHold?.runId !== runId) {
            return false;
        }

        options.clearHoldWatchdog();
        hold.value = null;
        return activeHold !== null;
    }

    function startHold(startOptions: IStartPagedNavigationHoldOptions) {
        clearHold();
        hold.value = {
            expired: false,
            runId: startOptions.runId,
            startedAtMs: getNow(),
            targetStart: startOptions.targetStart,
            targetEnd: startOptions.targetEnd,
        };
        options.armHoldWatchdog({
            runId: startOptions.runId,
            targetPage: startOptions.targetPage,
            readyRetryDelaysMs: startOptions.readyRetryDelaysMs,
            recoveryRenderMs: startOptions.recoveryRenderMs,
            abandonMs: startOptions.abandonMs,
            stallLogMs: startOptions.stallLogMs,
            onReadyRetry: startOptions.onReadyRetry,
            onRecovery: startOptions.onRecovery,
            onAbandon: startOptions.onAbandon,
            onStillWaiting: startOptions.onStillWaiting,
        });
    }

    function expireHold(runId: number) {
        const activeHold = hold.value;
        if (activeHold?.runId !== runId) {
            return null;
        }

        const expiredHold = {
            ...activeHold,
            expired: true,
        };
        hold.value = expiredHold;
        return expiredHold;
    }

    function isHoldActiveForPage(pageNumber: number) {
        const activeHold = hold.value;
        return activeHold !== null
            && pageNumber >= activeHold.targetStart
            && pageNumber <= activeHold.targetEnd;
    }

    function isHoldExpiredPage(pageNumber: number) {
        const activeHold = hold.value;
        return activeHold?.expired === true
            && pageNumber >= activeHold.targetStart
            && pageNumber <= activeHold.targetEnd;
    }

    function setFeedbackPage(page: number, reason: string, runId: number) {
        if (
            feedbackState.page === page
            && feedbackState.runId === runId
        ) {
            return false;
        }

        feedbackState = {
            page,
            runId,
        };
        const traceContext = options.getFeedbackTraceContext();
        logPdfRenderTrace('single-page-navigation-feedback-page', {
            page,
            reason,
            runId,
            currentPage: traceContext.currentPage,
            pagedNavigationTargetPage: traceContext.pagedNavigationTargetPage,
        });
        options.emitNavigationFeedbackPage?.(page);
        return true;
    }

    function clearFeedbackPage(reason: string, runId?: number) {
        if (
            runId !== undefined
            && feedbackState.runId !== runId
        ) {
            return false;
        }
        if (
            feedbackState.page === null
            && feedbackState.runId === null
        ) {
            return false;
        }

        const previous = feedbackState;
        feedbackState = {
            page: null,
            runId: null,
        };
        const traceContext = options.getFeedbackTraceContext();
        logPdfRenderTrace('single-page-navigation-feedback-page', {
            page: null,
            reason,
            runId: previous.runId,
            previousPage: previous.page,
            currentPage: traceContext.currentPage,
            pagedNavigationTargetPage: traceContext.pagedNavigationTargetPage,
        });
        options.emitNavigationFeedbackPage?.(null);
        return true;
    }

    function clearProgrammaticReleaseTimer() {
        const didClear = renderSupervisor.clearTimer(programmaticReleaseTimer);
        programmaticReleaseTimer = null;
        return didClear;
    }

    function scheduleProgrammaticRelease(scheduleOptions: IScheduleProgrammaticNavigationReleaseOptions) {
        clearProgrammaticReleaseTimer();
        if (!scheduleOptions.isActive() || scheduleOptions.isDisposed()) {
            return;
        }

        const delayMs = scheduleOptions.resolveDelayMs();
        programmaticReleaseTimer = renderSupervisor.armTimer({
            cause: 'navigation-programmatic-release',
            delayMs,
            key: 'navigation-programmatic-release',
            metadata: { delayMs },
            onFire: () => {
                programmaticReleaseTimer = null;
                scheduleOptions.onRelease();
                if (scheduleOptions.isActive() && !scheduleOptions.isDisposed()) {
                    scheduleProgrammaticRelease(scheduleOptions);
                }
            },
        });
    }

    function hasProgrammaticReleaseTimer() {
        return programmaticReleaseTimer !== null;
    }

    function dispose() {
        clearHold();
        clearProgrammaticReleaseTimer();
        clearTargetScrollOptions();
    }

    return {
        hold,
        clearFeedbackPage,
        clearHold,
        clearProgrammaticReleaseTimer,
        clearTargetScrollOptions,
        dispose,
        expireHold,
        getFeedbackState,
        getTargetScrollOptions,
        hasProgrammaticReleaseTimer,
        isHoldActiveForPage,
        isHoldExpiredPage,
        scheduleProgrammaticRelease,
        setFeedbackPage,
        setTargetScrollOptions,
        startHold,
    };
}
