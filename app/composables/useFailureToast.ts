import type {IPresentedFailureCapture} from '@app/utils/failureReporter';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

export interface IFailureToastAction {
    label: string;
    color?: 'neutral' | 'primary';
    variant?: 'outline' | 'soft';
    onClick: () => void;
}

// The public name is pinned by SEN-CORE-06 and intentionally differs from the
// repository's usual interface naming convention during this migration.
// eslint-disable-next-line @typescript-eslint/naming-convention
export interface FailurePresentation extends IPresentedFailureCapture {
    title: string;
    description?: string;
    actions?: IFailureToastAction[];
}

export interface IFailureToastTarget {add: (options: {
    color: 'error';
    title: string;
    description: string;
    actions: IFailureToastAction[];
}) => unknown}

const FAILURE_ERROR_ID_SHORT_LENGTH = 8;

export function getFailureErrorId(receipt: FailureReceipt) {
    return receipt.eventId.slice(0, FAILURE_ERROR_ID_SHORT_LENGTH);
}

function getNonEmptyDetails(values: Array<string | undefined>) {
    return values.filter((value): value is string => Boolean(value?.trim())).join('\n');
}

export function formatFailurePresentationDescription(presentation: FailurePresentation) {
    return getNonEmptyDetails([
        presentation.description,
        `Error ID: ${getFailureErrorId(presentation.failure)}`,
    ]);
}

export function formatFailurePresentationCopy(presentation: FailurePresentation) {
    return getNonEmptyDetails([
        `Error ID: ${presentation.failure.eventId}`,
        presentation.title,
        presentation.description,
    ]);
}

export function isFailurePresentation(value: unknown): value is FailurePresentation {
    return Boolean(
        value
        && typeof value === 'object'
        && 'failure' in value
        && Boolean(value.failure),
    );
}

export async function copyFailurePresentation(presentation: FailurePresentation) {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
        return false;
    }

    try {
        await navigator.clipboard.writeText(formatFailurePresentationCopy(presentation));
        return true;
    } catch {
        return false;
    }
}

export function createFailureToastPresenter(toast: IFailureToastTarget) {
    return function presentFailureToast(presentation: FailurePresentation) {
        toast.add({
            color: 'error',
            title: presentation.title,
            description: formatFailurePresentationDescription(presentation),
            actions: presentation.actions ?? [{
                label: 'Copy details',
                onClick: () => {
                    void copyFailurePresentation(presentation);
                },
            }],
        });
    };
}

export const useFailureToast = () => {
    const toast = useToast();
    const presentFailureToast = createFailureToastPresenter(toast);

    return {
        presentFailureToast,
        copyFailurePresentation,
    };
};
