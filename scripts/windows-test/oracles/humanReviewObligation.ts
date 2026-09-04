import type { IOracleResult } from '@scripts/windows-test/oracles/oracleResult';
import { createOracleResult } from '@scripts/windows-test/oracles/oracleResult';

export const HUMAN_REVIEW_ORACLE_ID = 'human-review';

export const HUMAN_REVIEW_ORACLE_VERSION = 'contact-sheet-obligation@1';

export interface IHumanReviewObligationInput {
    caseId: string;
    environmentId: string;
    /** Contact sheet or screenshot paths, relative to the run artifact directory. */
    artifacts: readonly string[];
    question: string;
    reviewerRole?: string;
}

export interface IHumanReviewObligation {
    kind: 'human-review';
    caseId: string;
    environmentId: string;
    artifacts: readonly string[];
    question: string;
    reviewerRole: string;
    /**
     * Always false when the lane produces the record. Only a person editing the
     * review record after looking at the contact sheet may flip this, so an
     * automated run can never close a visual obligation.
     */
    reviewed: false;
    verdict: null;
}

/**
 * A human review obligation is evidence that something still needs a person, so
 * the paired oracle result is always inconclusive. Treating a rendered contact
 * sheet as a pass would silently convert an unreviewed visual check into green.
 */
export function createHumanReviewObligation(
    input: IHumanReviewObligationInput,
): IHumanReviewObligation {
    return {
        kind: 'human-review',
        caseId: input.caseId,
        environmentId: input.environmentId,
        artifacts: [...input.artifacts],
        question: input.question,
        reviewerRole: input.reviewerRole ?? 'desktop-test-engineer',
        reviewed: false,
        verdict: null,
    };
}

export function humanReviewOracleResult(obligation: IHumanReviewObligation): IOracleResult {
    return createOracleResult({
        oracleId: HUMAN_REVIEW_ORACLE_ID,
        oracleVersion: HUMAN_REVIEW_ORACLE_VERSION,
        status: 'inconclusive',
        detail: `Case ${obligation.caseId} needs a human verdict on ${obligation.artifacts.length} artifact(s): ${obligation.question}`,
        observations: { obligation },
    });
}

export function formatHumanReviewObligation(obligation: IHumanReviewObligation) {
    return `${obligation.caseId} @ ${obligation.environmentId}: ${obligation.question} [${obligation.artifacts.join(', ')}]`;
}
