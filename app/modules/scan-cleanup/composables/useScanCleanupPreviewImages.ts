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
    // Blob already copies what it is handed, so the page-sized copy that used
    // to be made first was pure waste. The branch narrows rather than copies:
    // bytes off the IPC boundary are always ArrayBuffer-backed, and the view
    // shares them.
    const view = bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    return URL.createObjectURL(new Blob([view], {type: 'image/png'}));
}

export const useScanCleanupPreviewImages = (
    result: MaybeRefOrGetter<IScanCleanupPreviewResult | null>,
    onImagesChanged?: (hadPreviousResult: boolean) => void,
    rawResult: MaybeRefOrGetter<IScanCleanupRawPreviewResult | null> = result,
    detailResult: MaybeRefOrGetter<IScanCleanupPreviewResult | null> = () => null,
) => {
    const rawPixelSwap = ref(createPreviewImageSwap());
    const cleanedPixelSwaps = reactive<Partial<Record<TScanCleanupOutputHalf, IScanCleanupPreviewImageSwap>>>({});
    const displayedCleanedResult = shallowRef<IScanCleanupPreviewResult | null>(null);
    const pendingCleanedPixelUrls = reactive<Partial<Record<TScanCleanupOutputHalf, string>>>({});
    const detailPixelUrls = reactive<Partial<Record<TScanCleanupOutputHalf, string>>>({});
    let pendingCleanedResult: IScanCleanupPreviewResult | null = null;
    const loadedPendingCleanedUrls = new Set<string>();

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
        clearPendingCleanedFrame();
        for (const half of Object.keys(detailPixelUrls) as TScanCleanupOutputHalf[]) {
            const url = detailPixelUrls[half];
            if (url) revokeBlobUrl(url);
            Reflect.deleteProperty(detailPixelUrls, half);
        }
    }

    function loadRawPixelSwap(url: string) {
        rawPixelSwap.value = loadPreviewImageSwap(rawPixelSwap.value, url);
    }

    function completeRawPixelSwap(url: string) {
        rawPixelSwap.value = completePreviewImageSwap(rawPixelSwap.value, url, revokeBlobUrl);
    }

    function loadCleanedPixelSwap(half: TScanCleanupOutputHalf, url: string) {
        if (pendingCleanedPixelUrls[half] !== url || pendingCleanedResult === null) {
            return;
        }
        loadedPendingCleanedUrls.add(url);
        if (pendingCleanedResult.outputs.every(output => {
            const pendingUrl = pendingCleanedPixelUrls[output.metadata.half];
            return pendingUrl !== undefined && loadedPendingCleanedUrls.has(pendingUrl);
        })) {
            commitPendingCleanedFrame();
        }
    }

    function completeCleanedPixelSwap(half: TScanCleanupOutputHalf, url: string) {
        const state = cleanedPixelSwaps[half];
        if (state) cleanedPixelSwaps[half] = completePreviewImageSwap(state, url, revokeBlobUrl);
    }

    function clearPendingCleanedFrame() {
        for (const half of Object.keys(pendingCleanedPixelUrls) as TScanCleanupOutputHalf[]) {
            const url = pendingCleanedPixelUrls[half];
            if (url) revokeBlobUrl(url);
            Reflect.deleteProperty(pendingCleanedPixelUrls, half);
        }
        loadedPendingCleanedUrls.clear();
        pendingCleanedResult = null;
    }

    function publishCleanedFrame(nextResult: IScanCleanupPreviewResult) {
        const hadPreviousResult = displayedCleanedResult.value !== null;
        for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
            const state = cleanedPixelSwaps[half];
            if (state) disposePreviewImageSwap(state, revokeBlobUrl);
            Reflect.deleteProperty(cleanedPixelSwaps, half);
        }
        for (const output of nextResult.outputs) {
            const half = output.metadata.half;
            const pendingUrl = pendingCleanedPixelUrls[half];
            cleanedPixelSwaps[half] = createPreviewImageSwap(
                pendingUrl ?? pngUrl(output.imageData),
            );
            Reflect.deleteProperty(pendingCleanedPixelUrls, half);
        }
        displayedCleanedResult.value = nextResult;
        loadedPendingCleanedUrls.clear();
        pendingCleanedResult = null;
        onImagesChanged?.(hadPreviousResult);
    }

    function commitPendingCleanedFrame() {
        const nextResult = pendingCleanedResult;
        if (nextResult) publishCleanedFrame(nextResult);
    }

    watch(() => toValue(rawResult), (nextResult) => {
        if (!nextResult) {
            disposePreviewImageSwap(rawPixelSwap.value, revokeBlobUrl);
            rawPixelSwap.value = createPreviewImageSwap();
            return;
        }
        rawPixelSwap.value = queuePreviewImageSwap(rawPixelSwap.value, pngUrl(nextResult.rawImageData), revokeBlobUrl);
    }, {immediate: true});

    watch(() => toValue(result), (nextResult) => {
        if (!nextResult) {
            clearPendingCleanedFrame();
            for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
                const state = cleanedPixelSwaps[half];
                if (state) disposePreviewImageSwap(state, revokeBlobUrl);
                Reflect.deleteProperty(cleanedPixelSwaps, half);
            }
            displayedCleanedResult.value = null;
            return;
        }
        clearPendingCleanedFrame();
        if (!displayedCleanedResult.value) {
            publishCleanedFrame(nextResult);
            return;
        }
        pendingCleanedResult = nextResult;
        for (const output of nextResult.outputs) {
            const half = output.metadata.half;
            pendingCleanedPixelUrls[half] = pngUrl(output.imageData);
        }
        if (nextResult.outputs.length === 0) {
            commitPendingCleanedFrame();
        }
    }, {immediate: true});

    watch(() => toValue(detailResult), (nextResult) => {
        const activeHalves = new Set<TScanCleanupOutputHalf>();
        for (const output of nextResult?.outputs ?? []) {
            const half = output.metadata.half;
            activeHalves.add(half);
            const previous = detailPixelUrls[half];
            if (previous) revokeBlobUrl(previous);
            detailPixelUrls[half] = pngUrl(output.imageData);
        }
        for (const half of Object.keys(detailPixelUrls) as TScanCleanupOutputHalf[]) {
            if (!activeHalves.has(half)) {
                const url = detailPixelUrls[half];
                if (url) revokeBlobUrl(url);
                Reflect.deleteProperty(detailPixelUrls, half);
            }
        }
    }, {immediate: true});

    onBeforeUnmount(revokeUrls);

    return {
        cleanedPixelSwaps,
        completeCleanedPixelSwap,
        completeRawPixelSwap,
        detailPixelUrls,
        displayedCleanedResult,
        loadCleanedPixelSwap,
        loadRawPixelSwap,
        pendingCleanedPixelUrls,
        rawPixelSwap,
    };
};
