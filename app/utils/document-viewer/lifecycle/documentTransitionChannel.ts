/* eslint-disable custom/file-naming -- The shared lifecycle module is named for its domain role. */
export interface IDocumentTransitionFence {
    readonly loadToken: number;
    readonly documentVersion: number;
    readonly documentRevision: string | null;
    readonly openSurfaceGeneration: number;
}

export interface IDocumentTransition<TFence extends IDocumentTransitionFence> {
    readonly fence: TFence;
    readonly isCurrent: () => boolean;
}

type TDocumentTransitionInput<
    TFence extends IDocumentTransitionFence,
    TTransition extends IDocumentTransition<TFence>,
> = Omit<TTransition, 'isCurrent'>;

/**
 * Ordered, latest-wins transition delivery shared by document feature packs.
 *
 * The owner supplies the sole currentness predicate. A transition is checked
 * before delivery and again before every subscriber, so a listener that starts
 * a newer open prevents the stale transition reaching later session owners.
 */
export function createDocumentTransitionChannel<
    TFence extends IDocumentTransitionFence,
    TTransition extends IDocumentTransition<TFence>,
>(isFenceCurrent: (fence: TFence) => boolean) {
    const listeners = new Set<(transition: TTransition) => void | Promise<void>>();
    let disposed = false;

    function subscribe(listener: (transition: TTransition) => void | Promise<void>) {
        if (disposed) {
            return () => {};
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    async function publish(input: TDocumentTransitionInput<TFence, TTransition>) {
        if (disposed || !isFenceCurrent(input.fence)) {
            return false;
        }
        const transition = Object.freeze({
            ...input,
            isCurrent: () => !disposed && isFenceCurrent(input.fence),
        }) as TTransition;
        for (const listener of [...listeners]) {
            if (!transition.isCurrent()) {
                return false;
            }
            await listener(transition);
        }
        return transition.isCurrent();
    }

    function dispose() {
        disposed = true;
        listeners.clear();
    }

    return {
        subscribe,
        publish,
        dispose,
    };
}
