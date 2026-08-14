export const SCAN_CLEANUP_PREVIEW_SETTLE_GRACE_MS = 2_000;

export interface IScanCleanupPreviewPresentationPin {
    firstFrameArrivalAtMs: number;
    settleConsumed: boolean;
    transitionKey: string;
}

export type TScanCleanupPreviewPresentationAction = 'commit' | 'coalesce' | 'reject';

export interface IScanCleanupPreviewPresentationDecision {
    action: TScanCleanupPreviewPresentationAction;
    pin: IScanCleanupPreviewPresentationPin;
}

/**
 * A transition key changes only for a user/lifecycle/page transition. Detection
 * validity generations deliberately share it, so their presentation can settle
 * once near first paint and is then retained until the user moves on.
 */
export function resolveScanCleanupPreviewPresentationCommit(
    current: IScanCleanupPreviewPresentationPin | null,
    transitionKey: string,
    arrivedAtMs: number,
): IScanCleanupPreviewPresentationDecision {
    if (current === null || current.transitionKey !== transitionKey) {
        return {
            action: 'commit',
            pin: {
                firstFrameArrivalAtMs: arrivedAtMs,
                settleConsumed: false,
                transitionKey,
            },
        };
    }
    if (
        !current.settleConsumed
        && arrivedAtMs - current.firstFrameArrivalAtMs < SCAN_CLEANUP_PREVIEW_SETTLE_GRACE_MS
    ) {
        return {
            action: 'coalesce',
            pin: current,
        };
    }
    return {
        action: 'reject',
        pin: current.settleConsumed ? current : {
            ...current,
            settleConsumed: true,
        },
    };
}

export function consumeScanCleanupPreviewPresentationSettle(
    current: IScanCleanupPreviewPresentationPin,
): IScanCleanupPreviewPresentationPin {
    return current.settleConsumed ? current : {
        ...current,
        settleConsumed: true,
    };
}
