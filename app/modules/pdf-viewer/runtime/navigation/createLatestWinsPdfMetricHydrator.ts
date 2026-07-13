type TMetricHydration = (page: number) => Promise<boolean>;

interface IHydrationSubscriber {
    signal: AbortSignal;
    resolve: (result: boolean) => void;
    reject: (error: unknown) => void;
    abort: () => void;
}

interface IHydrationDemand {
    page: number;
    subscribers: Set<IHydrationSubscriber>;
}

function createAbortError(message = 'PDF page metric hydration was superseded') {
    return new DOMException(message, 'AbortError');
}

/**
 * Serializes PDF.js page-metric reads without making navigation wait for work
 * that has already lost ownership. PDF.js metric reads are not abortable, so
 * the active read is allowed to finish while subscribers observe AbortSignal
 * cancellation immediately. At most the newest different-page demand is kept
 * behind that read.
 */
export function createLatestWinsPdfMetricHydrator(hydrate: TMetricHydration) {
    let active: IHydrationDemand | null = null;
    let pending: IHydrationDemand | null = null;
    let disposed = false;

    function detach(subscriber: IHydrationSubscriber) {
        subscriber.signal.removeEventListener('abort', subscriber.abort);
    }

    function rejectSubscriber(subscriber: IHydrationSubscriber, error = createAbortError()) {
        detach(subscriber);
        subscriber.reject(error);
    }

    function rejectDemand(demand: IHydrationDemand | null, error = createAbortError()) {
        if (!demand) {
            return;
        }
        for (const subscriber of demand.subscribers) rejectSubscriber(subscriber, error);
        demand.subscribers.clear();
    }

    function settleDemand(demand: IHydrationDemand, result: boolean) {
        for (const subscriber of demand.subscribers) {
            detach(subscriber);
            if (subscriber.signal.aborted) {
                subscriber.reject(createAbortError());
            } else {
                subscriber.resolve(result);
            }
        }
        demand.subscribers.clear();
    }

    function failDemand(demand: IHydrationDemand, error: unknown) {
        for (const subscriber of demand.subscribers) {
            detach(subscriber);
            if (subscriber.signal.aborted) {
                subscriber.reject(createAbortError());
            } else {
                subscriber.reject(error);
            }
        }
        demand.subscribers.clear();
    }

    function start(demand: IHydrationDemand) {
        active = demand;
        let operation: Promise<boolean>;
        try {
            operation = Promise.resolve(hydrate(demand.page));
        } catch (error) {
            operation = Promise.reject(error);
        }
        void operation.then(
            result => settleDemand(demand, result),
            error => failDemand(demand, error),
        ).finally(() => {
            if (active !== demand) {
                return;
            }
            active = null;
            if (disposed) {
                rejectDemand(pending, createAbortError('PDF page metric hydration was disposed'));
                pending = null;
                return;
            }
            const next = pending;
            pending = null;
            if (next && next.subscribers.size > 0) start(next);
        });
    }

    function subscribe(demand: IHydrationDemand, signal: AbortSignal) {
        return new Promise<boolean>((resolve, reject) => {
            if (disposed || signal.aborted) {
                reject(createAbortError(disposed
                    ? 'PDF page metric hydration was disposed'
                    : undefined));
                return;
            }
            const subscriber: IHydrationSubscriber = {
                signal,
                resolve,
                reject,
                abort: () => {
                    demand.subscribers.delete(subscriber);
                    rejectSubscriber(subscriber);
                    if (pending === demand && demand.subscribers.size === 0) pending = null;
                },
            };
            demand.subscribers.add(subscriber);
            signal.addEventListener('abort', subscriber.abort, {once: true});
        });
    }

    function ensure(page: number, signal: AbortSignal) {
        if (active?.page === page) {
            // The newest request is already being served. Any different-page
            // demand waiting behind it is stale now.
            rejectDemand(pending);
            pending = null;
            return subscribe(active, signal);
        }
        if (pending?.page === page) {
            return subscribe(pending, signal);
        }

        const demand: IHydrationDemand = {
            page,
            subscribers: new Set(),
        };
        const subscription = subscribe(demand, signal);
        if (active) {
            rejectDemand(pending);
            pending = demand;
        } else if (demand.subscribers.size > 0) {
            start(demand);
        }
        return subscription;
    }

    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        rejectDemand(active, createAbortError('PDF page metric hydration was disposed'));
        rejectDemand(pending, createAbortError('PDF page metric hydration was disposed'));
        pending = null;
    }

    return {
        ensure,
        dispose,
    };
}
