export type TOcrJobLifecycleState =
    | 'preparing'
    | 'queued'
    | 'active'
    | 'cancelling'
    | 'terminal-result-sent'
    | 'finalized';

export type TOcrWorkerMessageRejectionReason =
    | 'mismatched-job-id'
    | 'inactive-worker'
    | 'terminal-result-already-sent';

export interface IOcrWorkerMessageDisposition {
    accepted: boolean;
    reason?: TOcrWorkerMessageRejectionReason;
}

interface IOcrWorkerMessageDispositionInput {
    incomingJobId: string;
    expectedRequestId: string;
    isCurrentWorker: boolean;
    terminalResultSent?: boolean;
    rejectAfterTerminalResult?: boolean;
}

const OCR_JOB_TRANSITIONS: Readonly<Record<TOcrJobLifecycleState, readonly TOcrJobLifecycleState[]>> = {
    preparing: [
        'queued',
        'cancelling',
        'finalized',
    ],
    queued: [
        'active',
        'cancelling',
        'finalized',
    ],
    active: [
        'cancelling',
        'terminal-result-sent',
        'finalized',
    ],
    cancelling: ['finalized'],
    'terminal-result-sent': ['finalized'],
    finalized: [],
};

export function canTransitionOcrJobLifecycle(
    current: TOcrJobLifecycleState,
    next: TOcrJobLifecycleState,
) {
    return OCR_JOB_TRANSITIONS[current].includes(next);
}

export function transitionOcrJobLifecycle<TNextState extends TOcrJobLifecycleState>(
    current: TOcrJobLifecycleState,
    next: TNextState,
    jobId: string,
) {
    if (!canTransitionOcrJobLifecycle(current, next)) {
        throw new Error(`Illegal OCR job lifecycle transition for ${jobId}: ${current} -> ${next}`);
    }
    return next;
}

export function getOcrWorkerMessageDisposition({
    incomingJobId,
    expectedRequestId,
    isCurrentWorker,
    terminalResultSent = false,
    rejectAfterTerminalResult = false,
}: IOcrWorkerMessageDispositionInput): IOcrWorkerMessageDisposition {
    if (incomingJobId !== expectedRequestId) {
        return {
            accepted: false,
            reason: 'mismatched-job-id',
        };
    }
    if (!isCurrentWorker) {
        return {
            accepted: false,
            reason: 'inactive-worker',
        };
    }
    if (rejectAfterTerminalResult && terminalResultSent) {
        return {
            accepted: false,
            reason: 'terminal-result-already-sent',
        };
    }
    return { accepted: true };
}
