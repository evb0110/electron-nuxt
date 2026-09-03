/* eslint-disable @typescript-eslint/naming-convention */

import type {Tagged} from 'type-fest';

export type DiagnosticEventId = Tagged<string, 'DiagnosticEventId'>;

export const DIAGNOSTIC_EVENT_ID_BYTES = 16;
export const DIAGNOSTIC_EVENT_ID_HEX_LENGTH = DIAGNOSTIC_EVENT_ID_BYTES * 2;

const DIAGNOSTIC_EVENT_ID_PATTERN = new RegExp(
    `^[0-9a-f]{${DIAGNOSTIC_EVENT_ID_HEX_LENGTH}}$`,
    'u',
);
const HEX_DIGITS = '0123456789abcdef';

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
    const cryptoSource = globalThis.crypto;
    if (cryptoSource === undefined || typeof cryptoSource.getRandomValues !== 'function') {
        throw new Error('Secure random values are unavailable for diagnostic event ID creation');
    }

    const bytes = new Uint8Array(DIAGNOSTIC_EVENT_ID_BYTES);
    cryptoSource.getRandomValues(bytes);

    let result = '';
    for (const byte of bytes) {
        result += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 0x0f]!;
    }
    return result as DiagnosticEventId;
}
