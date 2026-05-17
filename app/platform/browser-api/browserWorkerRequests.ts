export interface IPendingBrowserWorkerRequest<TValue = unknown> {
    resolve: (value: TValue) => void;
    reject: (error: Error) => void;
    timeoutTimer?: ReturnType<typeof setTimeout> | null;
}

export type TBrowserWorkerResult<TData = unknown> =
    | {
        id: number;
        ok: true;
        data: TData;
    }
    | {
        id: number;
        ok: false;
        error: string;
    };

export function settleBrowserWorkerResult<TData>(
    pendingRequests: Map<number, IPendingBrowserWorkerRequest<TData>>,
    result: TBrowserWorkerResult<TData>,
    onSettled: () => void,
) {
    const pending = pendingRequests.get(result.id);
    if (!pending) {
        return;
    }

    pendingRequests.delete(result.id);
    if (pending.timeoutTimer) {
        clearTimeout(pending.timeoutTimer);
        pending.timeoutTimer = null;
    }
    if (result.ok) {
        pending.resolve(result.data);
        onSettled();
        return;
    }

    pending.reject(new Error(result.error));
    onSettled();
}
