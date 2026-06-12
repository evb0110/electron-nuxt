

export function errorToLogText(error: unknown) {
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : (() => {
                try {
                    return JSON.stringify(error);
                } catch {
                    return String(error);
                }
            })();
    const stack = error instanceof Error ? error.stack ?? '' : '';
    return stack
        ? `${message}\n${stack}`
        : message;
}
