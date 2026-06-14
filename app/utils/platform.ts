import type { IPlatformApi } from '@contracts/platformApi';
import { delay } from 'es-toolkit/promise';
import { lazyBrowserPlatformApi } from '@app/platform/lazyBrowserPlatformApi';

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

export function isDesktopPlatformActive(electronApiAvailable = hasElectronAPI()) {
    return electronApiAvailable;
}

export function isBrowserPlatformActive(electronApiAvailable = hasElectronAPI()) {
    return !isDesktopPlatformActive(electronApiAvailable);
}

export function isElectronRoutePath(path: string | null | undefined) {
    return path === '/electron' || path?.startsWith('/electron/') === true;
}

export function isElectronUserAgent(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
    return /\bElectron\//u.test(userAgent);
}

export function shouldPreferDesktopPlatform(
    routePath: string | null | undefined,
    desktopRuntime = false,
    electronApiAvailable = hasElectronAPI(),
) {
    return electronApiAvailable || desktopRuntime || isElectronRoutePath(routePath);
}

export function resolveInitialDesktopRuntime(routePath: string | null | undefined, electronApiAvailable = hasElectronAPI()) {
    return shouldPreferDesktopPlatform(routePath, false, electronApiAvailable);
}

interface IWaitForDesktopPlatformBridgeOptions {
    shouldWait?: boolean;
    retryDelayMs?: number;
    attempts?: number;
}

export async function waitForDesktopPlatformBridge({
    shouldWait = true,
    retryDelayMs = 25,
    attempts = 20,
}: IWaitForDesktopPlatformBridgeOptions = {}) {
    if (!shouldWait || hasElectronAPI()) {
        return hasElectronAPI();
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        await delay(retryDelayMs);

        if (hasElectronAPI()) {
            return true;
        }
    }

    return hasElectronAPI();
}

export function getPlatformAPI(): IPlatformApi {
    const electronApi = getElectronWindow()?.electronAPI;
    return electronApi ?? lazyBrowserPlatformApi;
}
