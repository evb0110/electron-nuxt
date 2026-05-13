import type {
    IAppUpdateStatus,
    IUpdatesCapability,
} from '@contracts/platformApi';
import { noopUnsubscribe } from '@app/platform/browser-api/common';

type TUpdateStatusListener = (status: IAppUpdateStatus) => void;

const browserUpdateState: IAppUpdateStatus = {
    phase: 'unsupported',
    origin: 'auto',
    version: null,
    percent: null,
    message: null,
};
const updateStatusListeners = new Set<TUpdateStatusListener>();

export const browserUpdatesCapability: IUpdatesCapability = {
    getState() {
        return Promise.resolve(browserUpdateState);
    },
    check() {
        const manualUnsupportedStatus: IAppUpdateStatus = {
            ...browserUpdateState,
            origin: 'manual',
        };
        updateStatusListeners.forEach((listener) => {
            listener(manualUnsupportedStatus);
        });
        return Promise.resolve({ started: false });
    },
    install() {
        return Promise.resolve({ started: false });
    },
    defer() {
        return Promise.resolve();
    },
    skipVersion(_version) {
        return Promise.resolve();
    },
    onStatus(callback) {
        updateStatusListeners.add(callback);
        return () => {
            updateStatusListeners.delete(callback);
        };
    },
    onMenuCheckForUpdates: noopUnsubscribe,
};
