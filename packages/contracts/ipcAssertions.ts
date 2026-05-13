import {
    isNil,
    isString,
} from 'es-toolkit/predicate';
import { trim } from 'es-toolkit/string';

export const MAX_IPC_PATH_LENGTH = 4_096;

export function assertNonEmptyString(value: unknown, fieldName: string, maxLength = MAX_IPC_PATH_LENGTH) {
    if (!isString(value)) {
        throw new Error(`${fieldName} must be a string`);
    }

    const normalized = trim(value);
    if (!normalized) {
        throw new Error(`${fieldName} must not be empty`);
    }
    if (normalized.length > maxLength) {
        throw new Error(`${fieldName} exceeds maximum length (${maxLength})`);
    }
    if (normalized.includes('\0')) {
        throw new Error(`${fieldName} must not contain NUL bytes`);
    }

    return normalized;
}

export function isLikelyAbsolutePath(path: string) {
    return path.startsWith('/')
        || path.startsWith('\\\\')
        || /^[A-Za-z]:[\\/]/.test(path);
}

export function assertAbsolutePath(value: unknown, fieldName: string) {
    const normalized = assertNonEmptyString(value, fieldName);
    if (!isLikelyAbsolutePath(normalized)) {
        throw new Error(`${fieldName} must be an absolute path`);
    }
    return normalized;
}

export function assertOptionalAbsolutePath(value: unknown, fieldName: string) {
    if (isNil(value)) {
        return undefined;
    }

    if (isString(value) && trim(value).length === 0) {
        return undefined;
    }

    const normalized = assertNonEmptyString(value, fieldName);
    if (!isLikelyAbsolutePath(normalized)) {
        throw new Error(`${fieldName} must be an absolute path`);
    }
    return normalized;
}
