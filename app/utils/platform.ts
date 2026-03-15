import type { IElectronAPI } from '@contracts/electron-api';
import { browserPlatformApi } from '@app/platform/browser-api';

interface IWindowWithElectronApi extends Window {electronAPI?: IElectronAPI;}

function getElectronWindow() {
    if (typeof window === 'undefined') {
        return null;
    }

    return window as IWindowWithElectronApi;
}

export function hasElectronAPI() {
    return getElectronWindow()?.electronAPI !== undefined;
}

export function getPlatformAPI(): IElectronAPI {
    const electronApi = getElectronWindow()?.electronAPI;
    return electronApi ?? browserPlatformApi;
}

export function getElectronAPI(): IElectronAPI {
    return getPlatformAPI();
}
