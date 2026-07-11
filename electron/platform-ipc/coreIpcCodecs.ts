import type { TIpcCodecMap } from '@contracts/ipcMain';
import { decodeHostEnvironmentSnapshot } from '@contracts/electronApiHost';
import { decodeAppUpdateStatus } from '@contracts/electronApiUpdates';
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@contracts/settings';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferResult,
} from '@contracts/windowTabs';
import { decodeWindowTabTransferRequest } from '@contracts/windowTabsValidation';
import { decodeWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import {
    decodeBooleanArg,
    decodeStringArg,
    decodeStringArrayArg,
} from '@electron/platform-ipc/ipcArgumentValidation';
import {
    decodeBooleanResult,
    decodeNoArgs,
    decodeUndefinedResult,
    requireDecoded,
    requireIpcArgumentCount,
} from '@electron/platform-ipc/ipcCodecValidation';
import {
    CORE_IPC_CHANNELS,
    type ICoreInvokeMap,
} from '@electron/platform-ipc/coreContract';

function decodeOneArg<T>(args: readonly unknown[], decode: (value: unknown) => T): [T] {
    requireIpcArgumentCount(args, 1);
    return [decode(args[0])];
}

function decodeSettingsPatch(value: unknown): ICoreInvokeMap[typeof CORE_IPC_CHANNELS.settingsSave]['args'][0] {
    if (!isRecord(value)) {
        throw new Error('settings must be an object');
    }
    const normalized = sanitizeSettings({
        ...DEFAULT_SETTINGS,
        ...value,
    });
    for (const [
        key,
        candidate,
    ] of Object.entries(value)) {
        if (!(key in normalized) || normalized[key as keyof typeof normalized] !== candidate) {
            throw new Error(`invalid settings field: ${key}`);
        }
    }
    return value;
}

function decodeSettingsResult(value: unknown) {
    if (!isRecord(value)) {
        throw new Error('invalid settings result');
    }
    const normalized = sanitizeSettings(value);
    const allowedKeys = new Set(Object.keys(normalized));
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
            throw new Error(`invalid settings result field: ${key}`);
        }
    }
    for (const [
        key,
        candidate,
    ] of Object.entries(normalized)) {
        if (value[key] !== candidate) {
            throw new Error(`invalid settings result field: ${key}`);
        }
    }
    return normalized;
}

function decodeStartedResult(value: unknown) {
    if (!isRecord(value) || typeof value.started !== 'boolean') {
        throw new Error('expected a started result');
    }
    return {started: value.started};
}

function decodeStringArrayResult(value: unknown) {
    return decodeStringArrayArg([value], 0, 'result');
}

function decodeNullableWorkspaceCheckpoint(value: unknown) {
    if (value === null) {
        return null;
    }
    return requireDecoded(value, decodeWorkspaceCheckpoint, 'workspace checkpoint');
}

function decodeTransferAck(value: unknown): IWindowTabTransferAck {
    if (
        !isRecord(value)
        || typeof value.transferId !== 'string'
        || value.transferId.trim().length === 0
        || typeof value.success !== 'boolean'
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        throw new Error('invalid window tab transfer acknowledgement');
    }
    return {
        transferId: value.transferId,
        success: value.success,
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeTransferResult(value: unknown): IWindowTabTransferResult {
    if (
        !isRecord(value)
        || typeof value.transferId !== 'string'
        || typeof value.success !== 'boolean'
        || typeof value.targetWindowId !== 'number'
        || !Number.isSafeInteger(value.targetWindowId)
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        throw new Error('invalid window tab transfer result');
    }
    return {
        transferId: value.transferId,
        success: value.success,
        targetWindowId: value.targetWindowId,
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

function decodeTargetWindows(value: unknown): IWindowTabTargetWindow[] {
    if (!Array.isArray(value)) {
        throw new Error('expected an array of target windows');
    }
    return value.map((candidate) => {
        if (
            !isRecord(candidate)
            || typeof candidate.windowId !== 'number'
            || !Number.isSafeInteger(candidate.windowId)
            || candidate.windowId <= 0
            || typeof candidate.label !== 'string'
            || candidate.label.trim().length === 0
        ) {
            throw new Error('invalid target window');
        }
        return {
            windowId: candidate.windowId,
            label: candidate.label,
        };
    });
}

function decodeZenModeState(value: unknown) {
    if (!isRecord(value) || typeof value.active !== 'boolean' || typeof value.supported !== 'boolean') {
        throw new Error('invalid host zen mode state');
    }
    return {
        active: value.active,
        supported: value.supported,
    };
}

export const CORE_IPC_CODECS = {
    [CORE_IPC_CHANNELS.settingsGet]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeSettingsResult,
    },
    [CORE_IPC_CHANNELS.settingsSave]: {
        decodeArgs: (args: readonly unknown[]) => decodeOneArg(args, decodeSettingsPatch),
        decodeResult: decodeUndefinedResult,
    },
    [CORE_IPC_CHANNELS.updatesGetState]: {
        decodeArgs: decodeNoArgs,
        decodeResult: (value: unknown) => requireDecoded(value, decodeAppUpdateStatus, 'app update status'),
    },
    [CORE_IPC_CHANNELS.updatesCheck]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeStartedResult,
    },
    [CORE_IPC_CHANNELS.updatesInstall]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeStartedResult,
    },
    [CORE_IPC_CHANNELS.updatesDefer]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeUndefinedResult,
    },
    [CORE_IPC_CHANNELS.updatesSkipVersion]: {
        decodeArgs: (args: readonly unknown[]) => {
            requireIpcArgumentCount(args, 1);
            return [decodeStringArg(args, 0, 'version')];
        },
        decodeResult: decodeUndefinedResult,
    },
    [CORE_IPC_CHANNELS.shellOpenExternal]: {
        decodeArgs: (args: readonly unknown[]) => {
            requireIpcArgumentCount(args, 1);
            return [decodeStringArg(args, 0, 'url')];
        },
        decodeResult: decodeUndefinedResult,
    },
    [CORE_IPC_CHANNELS.windowCloseCurrent]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeBooleanResult,
    },
    [CORE_IPC_CHANNELS.claimPendingExternalOpenPaths]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeStringArrayResult,
    },
    [CORE_IPC_CHANNELS.acknowledgePendingExternalOpenPaths]: {
        decodeArgs: (args: readonly unknown[]) => {
            requireIpcArgumentCount(args, 1);
            return [decodeStringArrayArg(args, 0, 'failedPaths')];
        },
        decodeResult: decodeUndefinedResult,
    },
    [CORE_IPC_CHANNELS.workspaceCheckpointSave]: {
        decodeArgs: (args: readonly unknown[]) => decodeOneArg(
            args,
            value => requireDecoded(value, decodeWorkspaceCheckpoint, 'workspace checkpoint'),
        ),
        decodeResult: decodeUndefinedResult,
    },
    [CORE_IPC_CHANNELS.workspaceCheckpointClaim]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeNullableWorkspaceCheckpoint,
    },
    [CORE_IPC_CHANNELS.tabsTransfer]: {
        decodeArgs: (args: readonly unknown[]) => decodeOneArg(
            args,
            value => requireDecoded(value, decodeWindowTabTransferRequest, 'window tab transfer request'),
        ),
        decodeResult: decodeTransferResult,
    },
    [CORE_IPC_CHANNELS.tabsTransferAck]: {
        decodeArgs: (args: readonly unknown[]) => decodeOneArg(args, decodeTransferAck),
        decodeResult: decodeBooleanResult,
    },
    [CORE_IPC_CHANNELS.tabsListTargets]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeTargetWindows,
    },
    [CORE_IPC_CHANNELS.tabsShowContextMenu]: {
        decodeArgs: (args: readonly unknown[]) => {
            requireIpcArgumentCount(args, 1);
            return [decodeStringArg(args, 0, 'tabId')];
        },
        decodeResult: decodeUndefinedResult,
    },
    [CORE_IPC_CHANNELS.hostGetEnvironment]: {
        decodeArgs: decodeNoArgs,
        decodeResult: value => requireDecoded(value, decodeHostEnvironmentSnapshot, 'host environment'),
    },
    [CORE_IPC_CHANNELS.hostGetZenModeState]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeZenModeState,
    },
    [CORE_IPC_CHANNELS.hostSetZenMode]: {
        decodeArgs: (args: readonly unknown[]) => {
            requireIpcArgumentCount(args, 1);
            return [decodeBooleanArg(args, 0, 'active')];
        },
        decodeResult: decodeZenModeState,
    },
} satisfies TIpcCodecMap<ICoreInvokeMap>;
