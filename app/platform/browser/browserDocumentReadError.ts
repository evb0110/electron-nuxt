export const BROWSER_DOCUMENT_FULL_READ_TOO_LARGE = 'FULL_READ_TOO_LARGE';

export type TBrowserDocumentReadErrorCode = typeof BROWSER_DOCUMENT_FULL_READ_TOO_LARGE;

export class BrowserDocumentReadError extends Error {
    public readonly code: TBrowserDocumentReadErrorCode;

    public constructor(
        code: TBrowserDocumentReadErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'BrowserDocumentReadError';
        this.code = code;
    }
}

export function isBrowserFullReadTooLargeError(error: unknown) {
    return error instanceof BrowserDocumentReadError
        && error.code === BROWSER_DOCUMENT_FULL_READ_TOO_LARGE;
}
