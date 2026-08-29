import type {INativeErrorEnvelope} from '@contracts/nativeErrors';
import {SerializableError} from '@contracts/serializableError';
import {PDF_COMBINE_OUTPUT_POLICY} from '@contracts/pdfCombineOutputPolicy';
import {BROWSER_COMBINED_PDF_MAX_OUTPUT_BYTES} from '@app/platform/browser/browserDocumentConstants';

function browserCombineOutputLimitMessage() {
    return `ERR_BROWSER_PDF_COMBINE_INVALID_OUTPUT: Browser PDF combine output exceeds the shared browser combine cap (${Math.floor(BROWSER_COMBINED_PDF_MAX_OUTPUT_BYTES / (1024 * 1024))}MB)`;
}

export function createBrowserPdfCombineOutputErrorEnvelope(
    byteLength: number,
): INativeErrorEnvelope {
    if (byteLength > BROWSER_COMBINED_PDF_MAX_OUTPUT_BYTES) {
        return {
            code: PDF_COMBINE_OUTPUT_POLICY.tooLargeCode,
            message: browserCombineOutputLimitMessage(),
        };
    }

    return {
        code: 'invalid-request',
        message: 'ERR_BROWSER_PDF_COMBINE_INVALID_OUTPUT',
    };
}

export function createBrowserPdfCombineOutputError(byteLength: number) {
    return new SerializableError(createBrowserPdfCombineOutputErrorEnvelope(byteLength));
}
