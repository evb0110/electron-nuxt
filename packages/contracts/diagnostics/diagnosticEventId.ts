/* eslint-disable @typescript-eslint/naming-convention */

import type {Tagged} from 'type-fest';

export type DiagnosticEventId = Tagged<string, 'DiagnosticEventId'>;

export const DIAGNOSTIC_EVENT_ID_BYTES = 16;
export const DIAGNOSTIC_EVENT_ID_HEX_LENGTH = DIAGNOSTIC_EVENT_ID_BYTES * 2;

const DIAGNOSTIC_EVENT_ID_PATTERN = new RegExp(
    `^[0-9a-f]{${DIAGNOSTIC_EVENT_ID_HEX_LENGTH}}$`,
    'u',
);

export function isDiagnosticEventId(value: unknown): value is DiagnosticEventId {
    return typeof value === 'string'
        && DIAGNOSTIC_EVENT_ID_PATTERN.test(value);
}

export function parseDiagnosticEventId(value: unknown): DiagnosticEventId | null {
    return isDiagnosticEventId(value) ? value : null;
}

export const decodeDiagnosticEventId = parseDiagnosticEventId;

export function requireDiagnosticEventId(value: unknown): DiagnosticEventId {
    const parsed = parseDiagnosticEventId(value);
    if (parsed === null) {
        throw new TypeError(
            `Diagnostic event ID must contain exactly ${DIAGNOSTIC_EVENT_ID_HEX_LENGTH} lowercase hexadecimal characters`,
        );
    }
    return parsed;
}

export function createDiagnosticEventId(): DiagnosticEventId {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(DIAGNOSTIC_EVENT_ID_BYTES));
    let result = '';
    for (const byte of bytes) {
        result += byte.toString(16).padStart(2, '0');
    }
    return requireDiagnosticEventId(result);
}
