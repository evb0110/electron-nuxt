export class BrowserDocumentMutationQueue {
    private readonly queues = new Map<string, Promise<void>>();

    public run<T>(ref: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(ref) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(operation);
        const tracked = run.then(
            () => undefined,
            () => undefined,
        );
        this.queues.set(ref, tracked);
        void tracked.finally(() => {
            if (this.queues.get(ref) === tracked) {
                this.queues.delete(ref);
            }
        });
        return run;
    }

    public runMany<T>(refs: readonly string[], operation: () => Promise<T>): Promise<T> {
        const orderedRefs = Array.from(new Set(refs)).sort();
        const acquire = (index: number): Promise<T> => {
            const ref = orderedRefs[index];
            return ref === undefined
                ? operation()
                : this.run(ref, () => acquire(index + 1));
        };
        return acquire(0);
    }
}
