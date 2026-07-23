import type {
    IScanCleanupRawPreviewResult,
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
} from '@contracts/electronApiScanCleanup';
import type {MaybeRefOrGetter} from 'vue';

export interface IScanCleanupPreviewImageSwap {
    currentUrl: string;
    entering: boolean;
    incomingUrl: string;
    outgoingUrl: string;
}

export function createPreviewImageSwap(currentUrl = ''): IScanCleanupPreviewImageSwap {
    return {
        currentUrl,
        entering: false,
        incomingUrl: '',
        outgoingUrl: '',
    };
}

export function queuePreviewImageSwap(
    state: IScanCleanupPreviewImageSwap,
    url: string,
    revoke: (url: string) => void,
): IScanCleanupPreviewImageSwap {
    if (!state.currentUrl) {
        return createPreviewImageSwap(url);
    }
    if (state.incomingUrl) revoke(state.incomingUrl);
    if (state.outgoingUrl) revoke(state.outgoingUrl);
    return {
        currentUrl: state.currentUrl,
        entering: false,
        incomingUrl: url,
        outgoingUrl: '',
    };
}

export function loadPreviewImageSwap(state: IScanCleanupPreviewImageSwap, url: string) {
    if (state.incomingUrl !== url) {
        return state;
    }
    return {
        currentUrl: url,
        entering: true,
        incomingUrl: '',
        outgoingUrl: state.currentUrl,
    };
}

export function completePreviewImageSwap(
    state: IScanCleanupPreviewImageSwap,
    url: string,
    revoke: (url: string) => void,
) {
    if (!state.entering || state.currentUrl !== url) {
        return state;
    }
    if (state.outgoingUrl) revoke(state.outgoingUrl);
    return createPreviewImageSwap(state.currentUrl);
}

function disposePreviewImageSwap(state: IScanCleanupPreviewImageSwap, revoke: (url: string) => void) {
    for (const url of new Set([
        state.currentUrl,
        state.incomingUrl,
        state.outgoingUrl,
    ])) {
        if (url) revoke(url);
    }
}

function pngUrl(bytes: Uint8Array) {
    return URL.createObjectURL(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
}

export const useScanCleanupPreviewImages = (
    result: MaybeRefOrGetter<IScanCleanupPreviewResult | null>,
    onImagesChanged?: (hadPreviousResult: boolean) => void,
    rawResult: MaybeRefOrGetter<IScanCleanupRawPreviewResult | null> = result,
) => {
    const rawPixelSwap = ref(createPreviewImageSwap());
    const cleanedPixelSwaps = reactive<Partial<Record<TScanCleanupOutputHalf, IScanCleanupPreviewImageSwap>>>({});

    function revokeBlobUrl(url: string) {
        URL.revokeObjectURL(url);
    }

    function revokeUrls() {
        disposePreviewImageSwap(rawPixelSwap.value, revokeBlobUrl);
        rawPixelSwap.value = createPreviewImageSwap();
        for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
            const state = cleanedPixelSwaps[half];
            if (state) disposePreviewImageSwap(state, revokeBlobUrl);
            Reflect.deleteProperty(cleanedPixelSwaps, half);
        }
    }

    function loadRawPixelSwap(url: string) {
        rawPixelSwap.value = loadPreviewImageSwap(rawPixelSwap.value, url);
    }

    function completeRawPixelSwap(url: string) {
        rawPixelSwap.value = completePreviewImageSwap(rawPixelSwap.value, url, revokeBlobUrl);
    }

    function loadCleanedPixelSwap(half: TScanCleanupOutputHalf, url: string) {
        const state = cleanedPixelSwaps[half];
        if (state) cleanedPixelSwaps[half] = loadPreviewImageSwap(state, url);
    }

    function completeCleanedPixelSwap(half: TScanCleanupOutputHalf, url: string) {
        const state = cleanedPixelSwaps[half];
        if (state) cleanedPixelSwaps[half] = completePreviewImageSwap(state, url, revokeBlobUrl);
    }

    watch(() => toValue(rawResult), (nextResult) => {
        if (!nextResult) {
            disposePreviewImageSwap(rawPixelSwap.value, revokeBlobUrl);
            rawPixelSwap.value = createPreviewImageSwap();
            return;
        }
        rawPixelSwap.value = queuePreviewImageSwap(rawPixelSwap.value, pngUrl(nextResult.rawImageData), revokeBlobUrl);
    }, {immediate: true});

    watch(() => toValue(result), (nextResult, previousResult) => {
        if (!nextResult) {
            for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
                const state = cleanedPixelSwaps[half];
                if (state) disposePreviewImageSwap(state, revokeBlobUrl);
                Reflect.deleteProperty(cleanedPixelSwaps, half);
            }
            return;
        }
        const activeHalves = new Set<TScanCleanupOutputHalf>();
        for (const output of nextResult.outputs) {
            const half = output.metadata.half;
            activeHalves.add(half);
            cleanedPixelSwaps[half] = queuePreviewImageSwap(
                cleanedPixelSwaps[half] ?? createPreviewImageSwap(),
                pngUrl(output.imageData),
                revokeBlobUrl,
            );
        }
        for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
            if (!activeHalves.has(half)) {
                const state = cleanedPixelSwaps[half];
                if (state) disposePreviewImageSwap(state, revokeBlobUrl);
                Reflect.deleteProperty(cleanedPixelSwaps, half);
            }
        }
        onImagesChanged?.(Boolean(previousResult));
    }, {immediate: true});

    onBeforeUnmount(revokeUrls);

    return {
        cleanedPixelSwaps,
        completeCleanedPixelSwap,
        completeRawPixelSwap,
        loadCleanedPixelSwap,
        loadRawPixelSwap,
        rawPixelSwap,
    };
};
