import type { IPlatformApi } from '@contracts/platform-api';
import { browserPlatformApi } from '@app/platform/browser-api';

interface IWindowWithPlatformApi extends Window {electronAPI?: IPlatformApi;}

function getElectronWindow() {
    if (typeof window === 'undefined') {
        return null;
    }

    return window as IWindowWithPlatformApi;
}

export function hasElectronAPI() {
    return getElectronWindow()?.electronAPI !== undefined;
}

export function isElectronRoutePath(path: string | null | undefined) {
    return path === '/electron' || path?.startsWith('/electron/') === true;
}

export function resolveInitialDesktopRuntime(routePath: string | null | undefined, electronApiAvailable = hasElectronAPI()) {
    return electronApiAvailable || isElectronRoutePath(routePath);
}

export function getPlatformAPI(): IPlatformApi {
    const electronApi = getElectronWindow()?.electronAPI;
    return electronApi ?? browserPlatformApi;
}

/** @deprecated Prefer getPlatformAPI() in shared code. */
export function getElectronAPI(): IPlatformApi {
    return getPlatformAPI();
}
