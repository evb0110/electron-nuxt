import type {FailurePresentation} from '@app/composables/useFailureToast';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

export type TFatalRuntimeErrorKind = 'runtime' | 'startup';

export interface IFatalRuntimeError {
    kind: TFatalRuntimeErrorKind;
    detail: string | null;
    source: string;
    occurredAt: number;
    failure: FailureReceipt | null;
    title: string | null;
    description: string | null;
}

function isSameFatalRuntimeError(
    current: IFatalRuntimeError | null,
    kind: TFatalRuntimeErrorKind,
    detail: string | null,
    source: string,
    failure: FailureReceipt | null,
) {
    return Boolean(
        current
        && current.kind === kind
        && current.detail === detail
        && current.source === source
        && current.failure?.eventId === failure?.eventId,
    );
}

export const useFatalRuntimeError = () => {
    const fatalRuntimeError = useState<IFatalRuntimeError | null>('fatal-runtime-error', () => null);

    function setFatalRuntimeError(presentation: FailurePresentation): void;
    function setFatalRuntimeError(
        kind: TFatalRuntimeErrorKind,
        presentation: FailurePresentation,
    ): void;
    function setFatalRuntimeError(
        kindOrPresentation: TFatalRuntimeErrorKind | FailurePresentation,
        presentationArgument?: FailurePresentation,
    ) {
        const kind = typeof kindOrPresentation === 'string' ? kindOrPresentation : 'runtime';
        let presentation: FailurePresentation;
        if (typeof kindOrPresentation === 'string') {
            if (presentationArgument === undefined) {
                return;
            }
            presentation = presentationArgument;
        } else {
            presentation = kindOrPresentation;
        }
        const failure = presentation.failure;
        const detail = presentation.description ?? null;
        const source = presentation.failure.code;
        if (isSameFatalRuntimeError(fatalRuntimeError.value, kind, detail, source, failure)) {
            return;
        }

        fatalRuntimeError.value = {
            kind,
            detail,
            source,
            occurredAt: Date.now(),
            failure,
            title: presentation.title,
            description: presentation.description ?? null,
        };
    }

    function clearFatalRuntimeError() {
        fatalRuntimeError.value = null;
    }

    function reloadAfterFatalRuntimeError() {
        if (!import.meta.client || typeof window === 'undefined') {
            return;
        }
        window.location.reload();
    }

    return {
        fatalRuntimeError,
        setFatalRuntimeError,
        clearFatalRuntimeError,
        reloadAfterFatalRuntimeError,
    };
};
