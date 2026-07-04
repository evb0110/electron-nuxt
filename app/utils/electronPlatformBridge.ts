import { validateElectronPlatformApi } from '@app/platform/validatePlatformApi';

type TElectronPlatformApi = NonNullable<Window['electronAPI']>;

function getElectronWindow(): Window | null {
    if (typeof window === 'undefined') {
        return null;
    }

    return window;
}

export function getRawElectronPlatformApi(): TElectronPlatformApi | undefined {
    return getElectronWindow()?.electronAPI;
}

export function hasElectronPlatformBridge() {
    return getRawElectronPlatformApi() !== undefined;
}

export function getValidatedElectronPlatformApi(): TElectronPlatformApi | null {
    const electronApi = getRawElectronPlatformApi();
    if (electronApi === undefined) {
        return null;
    }
    return validateElectronPlatformApi(electronApi).ok ? electronApi : null;
}
