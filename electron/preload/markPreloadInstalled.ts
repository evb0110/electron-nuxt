const PRELOAD_INSTALL_FLAG = '__preloadInstalled';

export function markPreloadInstalled() {
    const preloadState = globalThis as Record<string, unknown>;
    const preloadAlreadyInstalled = preloadState[PRELOAD_INSTALL_FLAG] === true;
    if (!preloadAlreadyInstalled) {
        preloadState[PRELOAD_INSTALL_FLAG] = true;
    }

    return preloadAlreadyInstalled;
}
