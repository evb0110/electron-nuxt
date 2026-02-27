export interface ICancellationRegistry {
    create: (requestId: string) => AbortSignal;
    cancel: (requestId: string) => boolean;
    clear: (requestId: string) => void;
    cancelAll: () => void;
}

export function createCancellationRegistry(): ICancellationRegistry {
    const controllers = new Map<string, AbortController>();

    return {
        create: (requestId: string) => {
            const existing = controllers.get(requestId);
            if (existing) {
                existing.abort();
                controllers.delete(requestId);
            }

            const controller = new AbortController();
            controllers.set(requestId, controller);
            return controller.signal;
        },
        cancel: (requestId: string) => {
            const controller = controllers.get(requestId);
            if (!controller) {
                return false;
            }
            controller.abort();
            controllers.delete(requestId);
            return true;
        },
        clear: (requestId: string) => {
            controllers.delete(requestId);
        },
        cancelAll: () => {
            for (const controller of controllers.values()) {
                controller.abort();
            }
            controllers.clear();
        },
    };
}
