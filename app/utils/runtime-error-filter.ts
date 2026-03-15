const IGNORABLE_RUNTIME_ERROR_MESSAGES = [
    'ResizeObserver loop completed with undelivered notifications.',
    'ResizeObserver loop limit exceeded',
] as const;

function normalizeRuntimeErrorMessage(value: unknown): string | null {
    if (typeof value === 'string') {
        const normalized = value.trim();
        return normalized.length > 0
            ? normalized
            : null;
    }

    if (value instanceof Error) {
        return normalizeRuntimeErrorMessage(value.message);
    }

    if (
        typeof value === 'object'
        && value !== null
        && 'message' in value
    ) {
        return normalizeRuntimeErrorMessage((value as {message?: unknown}).message);
    }

    return null;
}

export function isIgnorableRuntimeErrorMessage(value: unknown): boolean {
    const normalizedMessage = normalizeRuntimeErrorMessage(value);
    if (!normalizedMessage) {
        return false;
    }

    return IGNORABLE_RUNTIME_ERROR_MESSAGES.some((message) => normalizedMessage.includes(message));
}

export function getIgnorableRuntimeErrorMessage(value: unknown): string | null {
    return isIgnorableRuntimeErrorMessage(value)
        ? normalizeRuntimeErrorMessage(value)
        : null;
}
