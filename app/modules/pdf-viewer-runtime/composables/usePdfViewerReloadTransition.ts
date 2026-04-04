import { BrowserLogger } from '@app/utils/browser-logger';

interface IUsePdfViewerReloadTransitionOptions {
    emitEffectiveZoom: (value: number) => void;
    summarizeViewerStateForLog?: () => unknown;
}

export function usePdfViewerReloadTransition(
    options: IUsePdfViewerReloadTransitionOptions,
) {
    const isVisualReloadTransitionActive = ref(false);
    const lastTransitionToken = ref(0);
    const activeTransitionToken = ref<number | null>(null);
    const pendingEffectiveZoom = ref<number | null>(null);

    function beginVisualReloadTransition(reason: string) {
        const token = lastTransitionToken.value + 1;
        lastTransitionToken.value = token;
        activeTransitionToken.value = token;
        pendingEffectiveZoom.value = null;
        isVisualReloadTransitionActive.value = true;

        BrowserLogger.warn('pdf-nav', `[viewer-reload-transition] begin token=${token} reason=${reason}`, {
            token,
            reason,
            viewer: options.summarizeViewerStateForLog?.() ?? null,
        });

        return token;
    }

    function endVisualReloadTransition(token: number, reason: string) {
        if (activeTransitionToken.value !== token) {
            return;
        }

        activeTransitionToken.value = null;
        isVisualReloadTransitionActive.value = false;

        const deferredEffectiveZoom = pendingEffectiveZoom.value;
        pendingEffectiveZoom.value = null;

        BrowserLogger.warn('pdf-nav', `[viewer-reload-transition] end token=${token} reason=${reason}`, {
            token,
            reason,
            deferredEffectiveZoom,
            viewer: options.summarizeViewerStateForLog?.() ?? null,
        });

        if (
            typeof deferredEffectiveZoom === 'number'
            && Number.isFinite(deferredEffectiveZoom)
            && deferredEffectiveZoom > 0
        ) {
            options.emitEffectiveZoom(deferredEffectiveZoom);
        }
    }

    function emitEffectiveZoom(value: number) {
        if (isVisualReloadTransitionActive.value) {
            pendingEffectiveZoom.value = value;
            return;
        }

        options.emitEffectiveZoom(value);
    }

    return {
        isVisualReloadTransitionActive,
        beginVisualReloadTransition,
        endVisualReloadTransition,
        emitEffectiveZoom,
    };
}
