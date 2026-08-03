import type {
    IScanCleanupOptions,
    IScanCleanupPagePlanEvidence,
    TScanCleanupLayoutByPage,
} from '@contracts/electronApiScanCleanup';
import type {TScanCleanupLog} from '@scan-cleanup-core/types';
import {resolveReusablePagePlanResult} from '@scan-cleanup-core/policy/effectiveOptions';

interface IPagePlanEvidenceInput {
    options: IScanCleanupOptions;
    layoutByPage?: TScanCleanupLayoutByPage;
    pagePlanEvidenceByPage?: Partial<Record<string, IScanCleanupPagePlanEvidence>>;
}

export function createPagePlanResolver(
    input: IPagePlanEvidenceInput,
    log: TScanCleanupLog,
    phase: 'lossless' | 'final',
) {
    let pinned = 0;
    let absent = 0;
    return {
        resolve(pageNumber: number) {
            const result = resolveReusablePagePlanResult(
                input.options,
                input.layoutByPage,
                input.pagePlanEvidenceByPage,
                pageNumber,
            );
            if (result.status === 'matched') {
                pinned += 1;
            } else if (result.status === 'absent') {
                absent += 1;
            } else {
                throw new Error(
                    `Stale scan cleanup page-plan evidence for page ${String(pageNumber)}:`
                    + ` ${result.status}`,
                );
            }
            return result.plan;
        },
        report() {
            log(
                'debug',
                `Scan cleanup ${phase} page-plan evidence:`
                + ` pinned=${String(pinned)} absent=${String(absent)} mismatched=0`,
            );
        },
    };
}
