export function createSearchReadinessPoll(delayMs: number) {
    const abortController = new AbortController();

    function wait() {
        const { signal } = abortController;
        return new Promise<boolean>(resolve => {
            if (signal.aborted) {
                resolve(false);
                return;
            }
            const timeoutId = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve(true);
            }, delayMs);
            const onAbort = () => {
                clearTimeout(timeoutId);
                resolve(false);
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    return {
        signal: abortController.signal,
        wait,
        dispose: () => abortController.abort(),
    };
}
