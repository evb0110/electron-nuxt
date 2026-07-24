import {
    isNativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA} from '@contracts/scan-cleanup/nativeProtocolV3';

export function decodeNativeScanCleanupEnvelope(line: string) {
    return NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA.decode(JSON.parse(line));
}

export function parseNativeScanCleanupStderr(stderr: string): {
    code: TNativeErrorCode;
    message: string
} | null {
    for (const line of stderr.trim().split(/\r?\n/u).reverse()) {
        try {
            const value: unknown = JSON.parse(line);
            if (isNativeErrorEnvelope(value)) {
                return value;
            }
        } catch {
            // Deprecation notices and diagnostics may precede the final native envelope.
        }
    }
    return null;
}
