import {
    getAnnotationCreationExpectedOutcome,
    type IAnnotationCreationFailureReport,
    type TAnnotationCreationFailureReason,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';
import { BrowserLogger } from '@app/utils/browserLogger';

interface IAnnotationCreationFailureInput {
    operationId: string;
    reason: TAnnotationCreationFailureReason;
    pageNumber: number | null;
}

/**
 * Classifies at the bridge owner. Handled states never capture, while a defect
 * gets one receipt before the presentation callback sees it.
 */
export function reportAnnotationCreationFailure(
    report: ((failure: IAnnotationCreationFailureReport) => void) | undefined,
    input: IAnnotationCreationFailureInput,
) {
    const expectedOutcome = getAnnotationCreationExpectedOutcome(input.reason);
    if (expectedOutcome) {
        report?.({
            ...input,
            kind: 'expected',
            outcome: expectedOutcome,
        });
        return;
    }

    const failure = BrowserLogger.error(
        'annotations',
        'Annotation creation failed',
        {reason: input.reason},
    );
    report?.({
        ...input,
        kind: 'fault',
        failure,
    });
}
