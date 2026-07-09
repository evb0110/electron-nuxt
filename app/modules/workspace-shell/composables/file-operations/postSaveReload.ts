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
    let current: IPostSaveReloadWaiter | null = null;
    let prepared = preserveLivePdfjsAnnotationSession;
    let finalized = false;
    function ensureCurrent() {
        if (!prepared) {
            prepared = true;
            current = preparePostSaveReload?.() ?? null;
        }
        return current;
    }
    return {
        get current() {
            return ensureCurrent();
        },
        get finalized() {
            return finalized;
        },
        cancel() {
            if (prepared) {
                current?.cancel();
            }
            current = null;
            prepared = true;
        },
        cancelPending() {
            if (!prepared || finalized) {
                return;
            }
            current?.cancel();
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
