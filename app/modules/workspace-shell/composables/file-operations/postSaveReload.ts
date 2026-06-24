export interface IPostSaveReloadWaiter {
    promise: Promise<void>;
    cancel: () => void;
}

export interface IPostSaveReloadHandle {
    readonly current: IPostSaveReloadWaiter | null;
    readonly finalized: boolean;
    cancel: () => void;
    cancelPending: () => void;
    markFinalized: () => void;
}

export function createPostSaveReloadHandle(
    preparePostSaveReload: (() => IPostSaveReloadWaiter) | undefined,
    preserveLivePdfjsAnnotationSession: boolean,
): IPostSaveReloadHandle {
    let current = preserveLivePdfjsAnnotationSession
        ? null
        : (preparePostSaveReload?.() ?? null);
    let finalized = false;
    return {
        get current() {
            return current;
        },
        get finalized() {
            return finalized;
        },
        cancel() {
            current?.cancel();
            current = null;
        },
        cancelPending() {
            if (current && !finalized) {
                current.cancel();
            }
        },
        markFinalized() {
            finalized = true;
        },
    };
}

export async function finalizePostSaveReload(
    reloadWaiter: IPostSaveReloadWaiter | null,
    saveSucceeded: boolean,
    callbacks: {
        onSaveFailed?: () => void;
        onSaveSucceeded?: () => void;
        onReloadFailed?: (error: unknown) => void;
    } = {},
) {
    if (!saveSucceeded) {
        callbacks.onSaveFailed?.();
        reloadWaiter?.cancel();
        return;
    }
    if (!reloadWaiter) {
        callbacks.onSaveSucceeded?.();
        return;
    }
    await reloadWaiter.promise.catch((error) => {
        callbacks.onReloadFailed?.(error);
    }).finally(() => {
        callbacks.onSaveSucceeded?.();
    });
}
