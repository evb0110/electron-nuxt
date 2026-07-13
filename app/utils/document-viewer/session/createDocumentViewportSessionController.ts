import type { ShallowRef } from 'vue';
import {
    createEmptyDocumentViewportSession,
    reduceDocumentViewportSession,
    type IDocumentViewportSessionState,
    type TDocumentViewportSessionEffect,
    type TDocumentViewportSessionEvent,
} from '@app/utils/document-viewer/session/documentViewportSession';

export interface IDocumentViewportSessionController {
    readonly snapshot: Readonly<ShallowRef<IDocumentViewportSessionState>>;
    dispatch(event: TDocumentViewportSessionEvent): boolean;
    subscribe(listener: (effect: TDocumentViewportSessionEffect) => void): () => void;
    dispose(): void;
}

export function createDocumentViewportSessionController(
    initialState = createEmptyDocumentViewportSession(),
): IDocumentViewportSessionController {
    const snapshot = shallowRef(initialState);
    const listeners = new Set<(effect: TDocumentViewportSessionEffect) => void>();
    const skeletonTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function cancelSkeletonTimer(token: string) {
        const timer = skeletonTimers.get(token);
        if (timer === undefined) {
            return;
        }
        clearTimeout(timer);
        skeletonTimers.delete(token);
    }

    function applyEffect(effect: TDocumentViewportSessionEffect) {
        if (effect.type === 'cancel-skeleton-delay') {
            cancelSkeletonTimer(effect.token);
        } else if (effect.type === 'schedule-skeleton-delay') {
            cancelSkeletonTimer(effect.token);
            const timer = setTimeout(() => {
                skeletonTimers.delete(effect.token);
                dispatch({
                    type: 'skeleton-delay-elapsed',
                    generation: effect.generation,
                    token: effect.token,
                });
            }, Math.max(0, effect.deadline - Date.now()));
            skeletonTimers.set(effect.token, timer);
        }
        for (const listener of listeners) listener(effect);
    }

    function dispatch(event: TDocumentViewportSessionEvent) {
        const transition = reduceDocumentViewportSession(snapshot.value, event);
        if (!transition.accepted) {
            return false;
        }
        snapshot.value = transition.state;
        for (const effect of transition.effects) applyEffect(effect);
        return true;
    }

    return {
        snapshot: readonly(snapshot),
        dispatch,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispose() {
            for (const token of skeletonTimers.keys()) cancelSkeletonTimer(token);
            listeners.clear();
        },
    };
}
