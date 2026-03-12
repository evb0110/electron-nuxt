import type { IElectronAPI } from '@contracts/electron-api';

interface IWindowWithElectronApi extends Window {electronAPI: IElectronAPI;}

function getElectronWindow(): IWindowWithElectronApi | null {
    if (typeof window === 'undefined' || window.electronAPI === undefined) {
        return null;
    }

    return window as IWindowWithElectronApi;
}

export function hasElectronAPI() {
    return getElectronWindow() !== null;
}

export function getElectronAPI(): IElectronAPI {
    const electronWindow = getElectronWindow();
    if (!electronWindow) {
        throw new Error('Electron API not available');
    }

    return electronWindow.electronAPI;
}
