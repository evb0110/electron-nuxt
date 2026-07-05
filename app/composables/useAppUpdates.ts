import type {
    IAppUpdateStatus,
    TAppUpdatePhase,
} from '@contracts/electronApiUpdates';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getUpdatesCapability,
    isUpdatesCapabilitySupported,
} from '@app/utils/platformUpdates';

export type TStatusDialogPhase = Exclude<TAppUpdatePhase, 'idle' | 'downloaded'>;

export interface IUpdateDialogState {
    open: boolean;
    kind: 'status' | 'ready';
    phase: TStatusDialogPhase;
    version: string | null;
    percent: number | null;
    message: string | null;
}

const DEFAULT_STATUS: IAppUpdateStatus = {
    phase: 'idle',
    origin: 'auto',
    version: null,
    percent: null,
    message: null,
};

const DEFAULT_DIALOG: IUpdateDialogState = {
    open: false,
    kind: 'status',
    phase: 'checking',
    version: null,
    percent: null,
    message: null,
};

const status = ref<IAppUpdateStatus>({ ...DEFAULT_STATUS });
const dialog = ref<IUpdateDialogState>({ ...DEFAULT_DIALOG });
const initialized = ref(false);
let statusUnsubscribe: (() => void) | null = null;
let initializationPromise: Promise<boolean> | null = null;

function toErrorMessage(error: unknown) {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    return String(error);
}

function openStatusDialog(nextStatus: IAppUpdateStatus) {
    if (nextStatus.phase === 'idle' || nextStatus.phase === 'downloaded') {
        return;
    }

    dialog.value = {
        open: true,
        kind: 'status',
        phase: nextStatus.phase,
        version: nextStatus.version,
        percent: nextStatus.percent,
        message: nextStatus.message,
    };
}

function openReadyDialog(version: string | null) {
    dialog.value = {
        open: true,
        kind: 'ready',
        phase: 'downloading',
        version,
        percent: 100,
        message: null,
    };
}

function closeDialog() {
    dialog.value.open = false;
}

function applyStatus(nextStatus: IAppUpdateStatus) {
    status.value = nextStatus;

    if (nextStatus.phase === 'downloaded') {
        openReadyDialog(nextStatus.version);
        return;
    }

    if (
        nextStatus.origin === 'manual'
        && nextStatus.phase !== 'idle'
    ) {
        openStatusDialog(nextStatus);
    }
}

async function ensureInitialized() {
    if (initialized.value) {
        return true;
    }
    if (initializationPromise) {
        return initializationPromise;
    }

    const updates = getUpdatesCapability();
    let receivedPushedStatus = false;
    const unsubscribe = updates.onStatus((nextStatus) => {
        receivedPushedStatus = true;
        initialized.value = true;
        applyStatus(nextStatus);
    });
    if (statusUnsubscribe && statusUnsubscribe !== unsubscribe) {
        statusUnsubscribe();
    }
    statusUnsubscribe = unsubscribe;

    initializationPromise = (async () => {
        try {
            const currentState = await updates.getState();
            if (!receivedPushedStatus) {
                applyStatus(currentState);
            }
            initialized.value = true;
            return true;
        } catch (error) {
            BrowserLogger.error('updates', 'Failed to load update status', error);
            if (receivedPushedStatus) {
                initialized.value = true;
                return true;
            }

            if (statusUnsubscribe === unsubscribe) {
                statusUnsubscribe();
                statusUnsubscribe = null;
            } else {
                unsubscribe();
            }
            initialized.value = false;
            return false;
        } finally {
            initializationPromise = null;
        }
    })();

    return initializationPromise;
}

async function checkForUpdates() {
    try {
        if (!await ensureInitialized()) {
            throw new Error('Updates status initialization failed.');
        }
        await getUpdatesCapability().check();
    } catch (error) {
        const message = toErrorMessage(error);
        BrowserLogger.error('updates', 'Failed to check for updates', error);
        applyStatus({
            phase: 'error',
            origin: 'manual',
            version: status.value.version,
            percent: null,
            message,
        });
    }
}

async function installUpdateNow() {
    try {
        closeDialog();
        await getUpdatesCapability().install();
    } catch (error) {
        const message = toErrorMessage(error);
        BrowserLogger.error('updates', 'Failed to install update', error);
        applyStatus({
            phase: 'error',
            origin: 'manual',
            version: status.value.version,
            percent: null,
            message,
        });
    }
}

async function deferUpdate() {
    try {
        closeDialog();
        await getUpdatesCapability().defer();
    } catch (error) {
        const message = toErrorMessage(error);
        BrowserLogger.error('updates', 'Failed to defer update', error);
        applyStatus({
            phase: 'error',
            origin: 'manual',
            version: status.value.version,
            percent: null,
            message,
        });
    }
}

async function skipUpdateVersion() {
    const version = dialog.value.version?.length ? dialog.value.version : status.value.version;
    if (!version) {
        closeDialog();
        return;
    }

    try {
        closeDialog();
        await getUpdatesCapability().skipVersion(version);
    } catch (error) {
        const message = toErrorMessage(error);
        BrowserLogger.error('updates', 'Failed to skip update version', error);
        applyStatus({
            phase: 'error',
            origin: 'manual',
            version: status.value.version,
            percent: null,
            message,
        });
    }
}

const isCheckInProgress = computed(() => {
    return status.value.phase === 'checking' || status.value.phase === 'downloading';
});

const isUpdateSupported = computed(() => {
    return isUpdatesCapabilitySupported(status.value);
});

const dialogVersion = computed(() => dialog.value.version?.length ? dialog.value.version : status.value.version);

export const useAppUpdates = () => {
    return {
        status,
        dialog,
        dialogVersion,
        isCheckInProgress,
        isUpdateSupported,
        ensureInitialized,
        checkForUpdates,
        installUpdateNow,
        deferUpdate,
        skipUpdateVersion,
        closeDialog,
    };
};

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        if (statusUnsubscribe) {
            statusUnsubscribe();
            statusUnsubscribe = null;
        }
        initializationPromise = null;
        initialized.value = false;
        status.value = { ...DEFAULT_STATUS };
        dialog.value = { ...DEFAULT_DIALOG };
    });
}
