export interface IScanCleanupPreviewPrefetchCandidate<TRequest> {
    key: string;
    request: TRequest;
}

export interface IScanCleanupPreviewPrefetchDependencies<TRequest, TResult> {
    isCached: (key: string) => boolean;
    preview: (request: TRequest) => Promise<TResult>;
    store: (key: string, result: TResult) => void;
}

export interface IScanCleanupPreviewPrefetcher<TRequest> {
    schedule: (candidates: Array<IScanCleanupPreviewPrefetchCandidate<TRequest>>) => void;
    supersede: () => void;
}

interface IQueuedPrefetch<TRequest> {
    candidates: Array<IScanCleanupPreviewPrefetchCandidate<TRequest>>;
    generation: number;
}

export function createScanCleanupPreviewPrefetcher<TRequest, TResult>(
    dependencies: IScanCleanupPreviewPrefetchDependencies<TRequest, TResult>,
): IScanCleanupPreviewPrefetcher<TRequest> {
    let generation = 0;
    let queued: IQueuedPrefetch<TRequest> | null = null;
    let worker: Promise<void> | null = null;

    async function drainQueue() {
        while (queued) {
            const current = queued;
            queued = null;
            for (const candidate of current.candidates) {
                if (current.generation !== generation) break;
                if (dependencies.isCached(candidate.key)) continue;
                try {
                    const result = await dependencies.preview(candidate.request);
                    if (current.generation !== generation) break;
                    dependencies.store(candidate.key, result);
                } catch {
                    if (current.generation !== generation) break;
                }
            }
        }
    }

    function startWorker() {
        if (worker) {
            return;
        }
        const current = drainQueue();
        worker = current;
        void current.finally(() => {
            if (worker === current) worker = null;
            if (queued) startWorker();
        }).catch(() => undefined);
    }

    return {
        schedule(candidates) {
            generation += 1;
            queued = {
                candidates,
                generation,
            };
            startWorker();
        },
        supersede() {
            generation += 1;
            queued = null;
        },
    };
}
