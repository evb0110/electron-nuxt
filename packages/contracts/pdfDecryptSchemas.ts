import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

/** Request to decrypt a PDF working copy; the password is never stored. */
export interface IPdfDecryptRequest {password?: string;}

/**
 * Outcome of the native/wasm decrypt operation as the app sees it:
 * `opened` for a file that needed no password and no rewrite, `rewritten` for
 * a decrypted working copy, plus the two failures mapped from the native error
 * codes (`needs-password`, `unsupported-encryption`).
 */
export type TPdfDecryptOutcome = 'opened' | 'rewritten' | 'needs-password' | 'unsupported-encryption';

export interface IPdfDecryptResult {
    outcome: TPdfDecryptOutcome;
    wasEncrypted: boolean;
    /** Standard security handler revision that was decrypted, when known. */
    revision: number | null;
}

/** Outcome values the app can receive from the native/wasm decrypt operation. */
export const PDF_DECRYPT_OUTCOMES = [
    'opened',
    'rewritten',
    'needs-password',
    'unsupported-encryption',
] as const;

export function isPdfDecryptOutcome(value: unknown): value is TPdfDecryptOutcome {
    return typeof value === 'string' && isOneOf(PDF_DECRYPT_OUTCOMES, value);
}

export function isPdfDecryptRequest(value: unknown): value is IPdfDecryptRequest {
    return value === undefined
        || (isRecord(value) && (value.password === undefined || typeof value.password === 'string'));
}

/** Runtime guard for the decrypt result shared by the CLI and the wasm entry. */
export function isPdfDecryptResult(value: unknown): value is IPdfDecryptResult {
    return isRecord(value)
        && isPdfDecryptOutcome(value.outcome)
        && typeof value.wasEncrypted === 'boolean'
        && (value.revision === null
            || (typeof value.revision === 'number'
                && Number.isSafeInteger(value.revision)
                && value.revision > 0));
}
