import type {
    IAppUpdateStatus,
    IUpdatesCapability,
} from '@contracts/electronApiUpdates';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';

type TUpdateStatusListener = (status: IAppUpdateStatus) => void;

const browserUpdateState = {
    phase: 'unsupported',
    origin: 'auto',
    version: null,
    percent: null,
    message: null,
} satisfies IAppUpdateStatus;
const updateStatusListeners = new Set<TUpdateStatusListener>();

export const browserUpdatesCapability = {
    getState() {
        return Promise.resolve(browserUpdateState);
    },
    check() {
        const manualUnsupportedStatus = {
            ...browserUpdateState,
            origin: 'manual',
        } satisfies IAppUpdateStatus;
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
} satisfies IUpdatesCapability;
