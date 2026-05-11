import type {
    IHostCapability,
    IHostEnvironmentSnapshot,
    THostPlatform,
} from '@contracts/electron-api-host';
import { noopUnsubscribe } from '@app/platform/browser-api/common';

function detectBrowserPlatform(): THostPlatform {
    if (typeof navigator === 'undefined') {
        return 'linux';
    }
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac') || ua.includes('darwin')) {
        return 'darwin';
    }
    if (ua.includes('win')) {
        return 'win32';
    }
    return 'linux';
}

function snapshotBrowserHostEnvironment(): IHostEnvironmentSnapshot {
    return {
        platform: detectBrowserPlatform(),
        osScaleFactor: 1,
    };
}

export const browserHostCapability: IHostCapability = {
    getEnvironment() {
        return Promise.resolve(snapshotBrowserHostEnvironment());
    },
    onEnvironmentChange: noopUnsubscribe,
};
