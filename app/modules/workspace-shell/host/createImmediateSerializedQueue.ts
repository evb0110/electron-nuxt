export function createImmediateSerializedQueue() {
    let tail: Promise<unknown> = Promise.resolve();
    let depth = 0;

    return async function enqueue<T>(run: () => Promise<T>): Promise<T> {
        const queuedRun = depth === 0
            ? run()
            : tail.catch(() => undefined).then(run);
        depth += 1;
        tail = queuedRun.catch(() => undefined);
        try {
            return await queuedRun;
        } finally {
            depth = Math.max(0, depth - 1);
        }
    };
}
