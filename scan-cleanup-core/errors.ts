export const SCAN_CLEANUP_OUTPUT_MISSING_ERROR_CODE = 'SCAN_CLEANUP_OUTPUT_MISSING' as const;
export const SCAN_CLEANUP_PDF_VALIDATION_ERROR_CODE = 'SCAN_CLEANUP_PDF_VALIDATION_FAILED' as const;

export class ScanCleanupMissingOutputError extends Error {
    readonly code = SCAN_CLEANUP_OUTPUT_MISSING_ERROR_CODE;
    readonly sourcePageNumber: number;
    readonly outputPath: string | undefined;
    readonly role: string;

    constructor(
        sourcePageNumber: number,
        outputPath: string | undefined,
        role: string,
        detail?: string,
    ) {
        super(
            `Scan cleanup produced output for source page ${String(sourcePageNumber)} is missing: ${role}`
            + (outputPath === undefined ? '' : ` at ${outputPath}`)
            + (detail === undefined ? '' : ` (${detail})`),
        );
        this.name = 'ScanCleanupMissingOutputError';
        this.sourcePageNumber = sourcePageNumber;
        this.outputPath = outputPath;
        this.role = role;
    }
}

export class ScanCleanupPdfValidationError extends Error {
    readonly code = SCAN_CLEANUP_PDF_VALIDATION_ERROR_CODE;
    readonly stagedPdfPath: string;

    constructor(stagedPdfPath: string, detail?: string) {
        super(
            `Scan cleanup staged PDF failed structural validation: ${stagedPdfPath}`
            + (detail === undefined ? '' : ` (${detail})`),
        );
        this.name = 'ScanCleanupPdfValidationError';
        this.stagedPdfPath = stagedPdfPath;
    }
}
