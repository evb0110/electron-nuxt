export function createDocumentPageSourceVisualRetryState(maxRetries: number) {
    const attempts = new Map<number, number>();

    return Object.freeze({
        beginSourceGeneration() {
            attempts.clear();
        },
        markReady(pageNumber: number) {
            attempts.delete(pageNumber);
        },
        releasePage(pageNumber: number) {
            attempts.delete(pageNumber);
        },
        recordFailure(pageNumber: number) {
            const attempt = attempts.get(pageNumber) ?? 0;
            if (attempt >= maxRetries) {
                return false;
            }
            attempts.set(pageNumber, attempt + 1);
            return true;
        },
    });
}
