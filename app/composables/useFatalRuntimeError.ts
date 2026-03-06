export type TFatalRuntimeErrorKind = 'runtime' | 'startup';

export interface IFatalRuntimeError {
    kind: TFatalRuntimeErrorKind;
    detail: string | null;
    source: string;
    occurredAt: number;
}

function stringifyRuntimeError(value: unknown): string | null {
    if (value instanceof Error) {
        if (value.message.trim().length > 0) {
            return `${value.name}: ${value.message}`;
        }
        return value.name || 'Error';
    }

    if (typeof value === 'string') {
        const normalized = value.trim();
        return normalized.length > 0
            ? normalized
            : null;
    }

    if (value === null || value === undefined) {
        return null;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function useFatalRuntimeError() {
    const fatalRuntimeError = useState<IFatalRuntimeError | null>('fatal-runtime-error', () => null);

    function setFatalRuntimeError(
        kind: TFatalRuntimeErrorKind,
        error: unknown,
        source: string,
    ) {
        const detail = stringifyRuntimeError(error);
        const current = fatalRuntimeError.value;
        if (
            current
            && current.kind === kind
            && current.detail === detail
            && current.source === source
        ) {
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
