import type {
    IPlatformApi,
    IPlatformRuntimeManifest,
} from '@contracts/platformApi';
import { delay } from 'es-toolkit/promise';
import { lazyBrowserPlatformApi } from '@app/platform/lazyBrowserPlatformApi';
import {
    PlatformContractError,
    validateBrowserPlatformApi,
    validateElectronPlatformApi,
} from '@app/platform/validatePlatformApi';
import {
    getRawElectronPlatformApi,
    getValidatedElectronPlatformApi,
    hasElectronPlatformBridge,
} from '@app/utils/electronPlatformBridge';

export function hasElectronAPI() {
    return getValidatedElectronPlatformApi() !== null;
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
    electronUserAgent = isElectronUserAgent(),
) {
    return electronApiAvailable || desktopRuntime || electronUserAgent || isElectronRoutePath(routePath);
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
    if (!shouldWait || hasElectronPlatformBridge()) {
        return hasElectronPlatformBridge();
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        await delay(retryDelayMs);

        if (hasElectronPlatformBridge()) {
            return true;
        }
    }

    return hasElectronPlatformBridge();
}

export function getPlatformManifest(): IPlatformRuntimeManifest {
    return getPlatformAPI().manifest;
}

function createPlatformContractError(result: ReturnType<typeof validateElectronPlatformApi>) {
    return new PlatformContractError(
        result.failures.map(failure => failure.message).join(' '),
        result.failures,
    );
}

export function getPlatformAPI(): IPlatformApi {
    const electronApi = getRawElectronPlatformApi();
    if (electronApi) {
        const result = validateElectronPlatformApi(electronApi);
        if (!result.ok) {
            throw createPlatformContractError(result);
        }
        return electronApi;
    }

    const browserResult = validateBrowserPlatformApi(lazyBrowserPlatformApi);
    if (!browserResult.ok) {
        throw createPlatformContractError(browserResult);
    }
    return lazyBrowserPlatformApi;
}
