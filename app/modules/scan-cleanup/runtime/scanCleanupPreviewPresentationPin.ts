export interface IScanCleanupPreviewPresentationPin {
    settledResultState: 'open' | 'loading' | 'committed';
    transitionKey: string;
}

export type TScanCleanupPreviewPresentationAction = 'commit' | 'coalesce' | 'reject';

export interface IScanCleanupPreviewPresentationDecision {
    action: TScanCleanupPreviewPresentationAction;
    pin: IScanCleanupPreviewPresentationPin;
}

/**
 * A transition key changes only for a user/lifecycle/page transition. Detection
 * validity generations deliberately share it: provisional generations
 * coalesce behind the displayed frame, the first settled generation crosses
 * the pin once, and every later automatic generation is rejected.
 */
export function resolveScanCleanupPreviewPresentationCommit(
    current: IScanCleanupPreviewPresentationPin | null,
    transitionKey: string,
    settled: boolean,
): IScanCleanupPreviewPresentationDecision {
    if (current === null || current.transitionKey !== transitionKey) {
        return {
            action: 'commit',
            pin: {
                settledResultState: settled ? 'loading' : 'open',
                transitionKey,
            },
        };
    }
    if (current.settledResultState !== 'open') {
        return {
            action: 'reject',
            pin: current,
        };
    }
    if (!settled) {
        return {
            action: 'coalesce',
            pin: current,
        };
    }
    return {
        action: 'commit',
        pin: {
            ...current,
            settledResultState: 'loading',
        },
    };
}

export function commitScanCleanupPreviewPresentationSettle(
    current: IScanCleanupPreviewPresentationPin,
): IScanCleanupPreviewPresentationPin {
    return current.settledResultState === 'loading' ? {
        ...current,
        settledResultState: 'committed',
    } : current;
}

export function resetScanCleanupPreviewPresentationSettle(
    current: IScanCleanupPreviewPresentationPin,
): IScanCleanupPreviewPresentationPin {
    return current.settledResultState === 'loading' ? {
        ...current,
        settledResultState: 'open',
    } : current;
}
