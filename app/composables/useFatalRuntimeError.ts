export type TFatalRuntimeErrorKind = 'runtime' | 'startup';

export interface IFatalRuntimeError {
    kind: TFatalRuntimeErrorKind;
    detail: string | null;
    source: string;
    occurredAt: number;
}

function stringifyErrorObject(error: Error): string {
    if (error.message.trim().length > 0) {
        return `${error.name}: ${error.message}`;
    }
    return error.name || 'Error';
}

function normalizeRuntimeErrorString(value: string): string | null {
    const normalized = value.trim();
    return normalized.length > 0
        ? normalized
        : null;
}

function stringifyRuntimeErrorValue(value: unknown): string {
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

function stringifyRuntimeError(value: unknown): string | null {
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
) {
    return Boolean(
        current
        && current.kind === kind
        && current.detail === detail
        && current.source === source,
    );
}

export function useFatalRuntimeError() {
    const fatalRuntimeError = useState<IFatalRuntimeError | null>('fatal-runtime-error', () => null);

    function setFatalRuntimeError(
        kind: TFatalRuntimeErrorKind,
        error: unknown,
        source: string,
    ) {
        const detail = stringifyRuntimeError(error);
        if (isSameFatalRuntimeError(fatalRuntimeError.value, kind, detail, source)) {
            return;
        }

        fatalRuntimeError.value = {
            kind,
            detail,
            source,
            occurredAt: Date.now(),
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
}
