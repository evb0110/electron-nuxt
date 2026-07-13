

export function isRenderingCancelledError(error: unknown) {
    if (!error) {
        return false;
    }
    if (
        typeof error === 'object'
        && 'name' in error
        && (
            (error as { name?: string }).name === 'RenderingCancelledException'
            || (error as { name?: string }).name === 'AbortError'
            || (error as { name?: string }).name === 'AbortException'
        )
    ) {
        return true;
    }

    const message = typeof error === 'string'
        ? error
        : (
            typeof error === 'object'
            && error !== null
            && 'message' in error
            && typeof (error as { message?: unknown }).message === 'string'
        )
            ? (error as { message: string }).message
            : '';

    return /rendering cancelled/i.test(message);
}
