import {
    isFailurePresentation,
    type FailurePresentation,
} from '@app/composables/useFailureToast';
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

function stringifyErrorObject(error: Error) {
    if (error.message.trim().length > 0) {
        return `${error.name}: ${error.message}`;
    }
    return error.name || 'Error';
}

function normalizeRuntimeErrorString(value: string) {
    const normalized = value.trim();
    return normalized.length > 0
        ? normalized
        : null;
}

function stringifyRuntimeErrorValue(value: unknown) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function isNullishRuntimeError(value: unknown) {
    return value === null || value === undefined;
}

const RUNTIME_ERROR_STRINGIFIERS = [
    {
        matches: (value: unknown) => value instanceof Error,
        stringify: (value: unknown) => stringifyErrorObject(value as Error),
    },
    {
        matches: (value: unknown) => typeof value === 'string',
        stringify: (value: unknown) => normalizeRuntimeErrorString(value as string),
    },
    {
        matches: isNullishRuntimeError,
        stringify: () => null,
    },
];

function stringifyRuntimeError(value: unknown) {
    const stringifier = RUNTIME_ERROR_STRINGIFIERS.find(candidate => candidate.matches(value));
    return stringifier
        ? stringifier.stringify(value)
        : stringifyRuntimeErrorValue(value);
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
    /** Remove this compatibility overload at the Phase 2 exit when the unclassified-code migration report reaches zero. */
    function setFatalRuntimeError(
        kind: TFatalRuntimeErrorKind,
        error: unknown,
        source: string,
    ): void;
    function setFatalRuntimeError(
        kindOrPresentation: TFatalRuntimeErrorKind | FailurePresentation,
        errorOrPresentation?: unknown,
        legacySource?: string,
    ) {
        const hasLeadingPresentation = isFailurePresentation(kindOrPresentation);
        const hasSecondPresentation = isFailurePresentation(errorOrPresentation);
        const kind = hasLeadingPresentation ? 'runtime' : kindOrPresentation;
        const presentation = hasLeadingPresentation
            ? kindOrPresentation
            : hasSecondPresentation
                ? errorOrPresentation
                : null;
        const failure = presentation?.failure ?? null;
        const detail = presentation
            ? presentation.description ?? null
            : stringifyRuntimeError(errorOrPresentation);
        const source = presentation
            ? presentation.failure.code
            : legacySource ?? '';
        if (isSameFatalRuntimeError(fatalRuntimeError.value, kind, detail, source, failure)) {
            return;
        }

        fatalRuntimeError.value = {
            kind,
            detail,
            source,
            occurredAt: Date.now(),
            failure,
            title: presentation?.title ?? null,
            description: presentation?.description ?? null,
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
