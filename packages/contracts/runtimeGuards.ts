export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface IErrnoLikeException extends Error {
    code?: string | number;
    errno?: number;
    path?: string;
    syscall?: string;
}

export function isErrnoException(value: unknown): value is IErrnoLikeException {
    return isRecord(value) && 'code' in value;
}
