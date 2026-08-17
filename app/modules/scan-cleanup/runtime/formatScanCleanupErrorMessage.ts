const MAX_SCAN_CLEANUP_TECHNICAL_DETAIL_LENGTH = 240;

function getScanCleanupTechnicalDetail(error: unknown) {
    const detail = typeof error === 'string'
        ? error
        : error instanceof Error
            ? error.message
            : '';
    const trimmed = detail.trim();
    if (trimmed.length <= MAX_SCAN_CLEANUP_TECHNICAL_DETAIL_LENGTH) {
        return trimmed;
    }
    return `${trimmed.slice(0, MAX_SCAN_CLEANUP_TECHNICAL_DETAIL_LENGTH - 3)}...`;
}

/**
 * Keeps renderer-owned wording localized while retaining a short raw bridge
 * detail for diagnostics when the existing alert/toast has no separate detail
 * channel.
 */
export function formatScanCleanupErrorMessage(message: string, error: unknown) {
    const detail = getScanCleanupTechnicalDetail(error);
    return detail && detail !== message
        ? `${message} (${detail})`
        : message;
}
