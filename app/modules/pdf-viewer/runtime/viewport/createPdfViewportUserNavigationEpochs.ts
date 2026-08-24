import type { Ref } from 'vue';

export interface IPdfViewportUserNavigationEpochs {
    /** Advances on every scroll the viewer did not author itself. */
    readonly userViewportInteractionEpoch: Ref<number>;
    /** Advances only on trusted input the user aimed at the viewport. */
    readonly userPhysicalNavigationEpoch: Ref<number>;
    beginLayoutGeometryReplacement: () => () => void;
    markPhysicalNavigation: () => void;
    markScrollInteraction: () => void;
}

/**
 * Two epochs describe viewport ownership, because one cannot.
 *
 * The interaction epoch answers "did the scroll offset stop being the one the
 * viewer wrote?", which every scroll event satisfies - including the ones the
 * browser emits when a fit change rewrites every row's height. Guarding a
 * fit re-anchor on that epoch makes the command cancel itself.
 *
 * The physical epoch answers "did the user take the viewport?" and stays put
 * across viewer-driven geometry replacement, so a fit change is superseded
 * only by real wheel or pointer navigation.
 */
export function createPdfViewportUserNavigationEpochs(): IPdfViewportUserNavigationEpochs {
    const userViewportInteractionEpoch = ref(0);
    const userPhysicalNavigationEpoch = ref(0);
    let layoutGeometryReplacementDepth = 0;

    return {
        userViewportInteractionEpoch,
        userPhysicalNavigationEpoch,
        beginLayoutGeometryReplacement() {
            layoutGeometryReplacementDepth += 1;
            let closed = false;
            return () => {
                if (closed) {
                    return;
                }
                closed = true;
                layoutGeometryReplacementDepth = Math.max(0, layoutGeometryReplacementDepth - 1);
            };
        },
        markPhysicalNavigation() {
            userViewportInteractionEpoch.value += 1;
            userPhysicalNavigationEpoch.value += 1;
        },
        markScrollInteraction() {
            userViewportInteractionEpoch.value += 1;
            if (layoutGeometryReplacementDepth === 0) {
                userPhysicalNavigationEpoch.value += 1;
            }
        },
    };
}
