import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

export const NATIVE_ERROR_CODES = [
    'encrypted',
    'too-large',
    'corrupt-xref',
    'unsupported-filter',
    'invalid-request',
    'io',
    'panic',
    'native-failure',
] as const;

export type TNativeErrorCode = typeof NATIVE_ERROR_CODES[number];

export interface INativeErrorEnvelope {
    code: TNativeErrorCode;
    message: string;
}

export function isNativeErrorEnvelope(value: unknown): value is INativeErrorEnvelope {
    return isRecord(value)
        && isOneOf(NATIVE_ERROR_CODES, value.code)
        && typeof value.message === 'string';
}

export function hasNativeErrorCode(value: unknown): value is {code: TNativeErrorCode} {
    return isRecord(value) && isOneOf(NATIVE_ERROR_CODES, value.code);
}
