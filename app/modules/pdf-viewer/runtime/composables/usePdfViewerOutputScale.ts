function readWindowOutputScale() {
    return typeof window !== 'undefined'
        ? window.devicePixelRatio || 1
        : 1;
}

export function usePdfViewerOutputScale() {
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
        if (outputScale.value !== nextScale) {
            outputScale.value = nextScale;
        }
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
}
