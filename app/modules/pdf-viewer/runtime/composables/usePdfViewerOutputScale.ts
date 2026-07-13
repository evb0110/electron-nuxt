const PDF_CANONICAL_OUTPUT_SCALE = 2;

function readWindowOutputScale() {
    return typeof window !== 'undefined'
        ? Math.max(PDF_CANONICAL_OUTPUT_SCALE, window.devicePixelRatio || 1)
        : PDF_CANONICAL_OUTPUT_SCALE;
}

export function shouldDeferPdfDprRerenderForResize(isResizing: boolean) {
    return isResizing;
}

export const usePdfViewerOutputScale = () => {
    const outputScale = ref(readWindowOutputScale());
    let mediaQuery: MediaQueryList | null = null;

    function removeMediaListener() {
        if (!mediaQuery) {
            return;
        }

        mediaQuery.removeEventListener('change', updateOutputScale);
        mediaQuery = null;
    }

    function installMediaListener() {
        removeMediaListener();
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return;
        }

        mediaQuery = window.matchMedia(`(resolution: ${outputScale.value}dppx)`);
        mediaQuery.addEventListener('change', updateOutputScale);
    }

    function updateOutputScale() {
        const nextScale = readWindowOutputScale();
        if (outputScale.value === nextScale) {
            return;
        }

        outputScale.value = nextScale;
        installMediaListener();
    }

    if (typeof window !== 'undefined') {
        installMediaListener();
        window.addEventListener('resize', updateOutputScale);
    }

    onScopeDispose(() => {
        removeMediaListener();
        if (typeof window !== 'undefined') {
            window.removeEventListener('resize', updateOutputScale);
        }
    });

    return outputScale;
};
