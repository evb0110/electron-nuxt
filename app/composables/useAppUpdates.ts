
import type {
    IAppUpdateStatus,
    TAppUpdatePhase,
} from '@contracts/platform-api';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getElectronAPI } from '@app/utils/platform';

type TStatusDialogPhase = Exclude<TAppUpdatePhase, 'idle' | 'downloaded'>;

interface IUpdateDialogState {
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

const status = ref<IAppUpdateStatus>({ ...DEFAULT_STATUS });
const dialog = ref<IUpdateDialogState>({
    open: false,
    kind: 'status',
    phase: 'checking',
    version: null,
    percent: null,
    message: null,
});
const initialized = ref(false);
let statusUnsubscribe: (() => void) | null = null;

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
        return;
    }

    initialized.value = true;
    const electronApi = getElectronAPI();

    try {
        const currentState = await electronApi.updates.getState();
        applyStatus(currentState);
    } catch (error) {
        BrowserLogger.error('updates', 'Failed to load update status', error);
    }

    statusUnsubscribe = electronApi.updates.onStatus((nextStatus) => {
        applyStatus(nextStatus);
    });
}

async function checkForUpdates() {
    try {
        await ensureInitialized();
        await getElectronAPI().updates.check();
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
        await getElectronAPI().updates.install();
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
        await getElectronAPI().updates.defer();
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
    const version = dialog.value.version || status.value.version;
    if (!version) {
        closeDialog();
        return;
    }

    try {
        closeDialog();
        await getElectronAPI().updates.skipVersion(version);
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
    return status.value.phase !== 'unsupported';
});

const dialogVersion = computed(() => dialog.value.version || status.value.version);

export function useAppUpdates() {
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
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        if (statusUnsubscribe) {
            statusUnsubscribe();
            statusUnsubscribe = null;
        }
    });
}
