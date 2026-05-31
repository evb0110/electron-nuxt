import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
} from '@contracts/ipcAssertions';

const MAX_IPC_FILE_NAME_LENGTH = 255;
const MAX_IPC_WRITE_BYTES = 512 * 1024 * 1024;

function assertWriteData(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    if (value.byteLength === 0) {
        throw new Error(`${fieldName} must not be empty`);
    }
    if (value.byteLength > MAX_IPC_WRITE_BYTES) {
        throw new Error(`${fieldName} exceeds maximum size (${MAX_IPC_WRITE_BYTES} bytes)`);
    }
    return value;
}

function assertWorkingCopyFileName(value: unknown, fieldName: string) {
    const normalized = assertNonEmptyString(value, fieldName, MAX_IPC_FILE_NAME_LENGTH);
    if (normalized.includes('/') || normalized.includes('\\')) {
        throw new Error(`${fieldName} must be a file name, not a path`);
    }
    if (normalized === '.' || normalized === '..') {
        throw new Error(`${fieldName} is invalid`);
    }
    return normalized;
}

export {
    MAX_IPC_FILE_NAME_LENGTH,
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    assertWriteData,
    assertWorkingCopyFileName,
};

export type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
};
