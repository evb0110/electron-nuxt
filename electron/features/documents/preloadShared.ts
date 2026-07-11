import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
} from '@contracts/ipcAssertions';
import { IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES } from '@contracts/electronApiDocuments';

const MAX_IPC_FILE_NAME_LENGTH = 255;
const MAX_IPC_WRITE_BYTES = IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES;

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
    TMenuEventCallback,
    TMenuEventUnsubscribe,
};
