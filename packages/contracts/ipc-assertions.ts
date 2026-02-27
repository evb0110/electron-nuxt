export const MAX_IPC_PATH_LENGTH = 4_096;

export function assertNonEmptyString(value: unknown, fieldName: string, maxLength = MAX_IPC_PATH_LENGTH) {
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }

    const normalized = value.trim();
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
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value === 'string' && value.trim().length === 0) {
        return undefined;
    }

    const normalized = assertNonEmptyString(value, fieldName);
    if (!isLikelyAbsolutePath(normalized)) {
        throw new Error(`${fieldName} must be an absolute path`);
    }
    return normalized;
}
