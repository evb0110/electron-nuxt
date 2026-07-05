import { basename } from 'node:path';
import {
    runNativeCommand,
    type IRunCommandOptions,
} from '@electron/native-tools/runNativeCommand';
import type { IProcessResult } from '@electron/native-tools/processResult';

export interface IRunNativeToolCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    rejectOnStdoutTruncation?: boolean;
    allowedExitCodes?: number[];
    signal?: AbortSignal;
    cancelGroup?: string;
    commandLabel?: string;
    log?: (level: 'debug' | 'warn' | 'error', message: string) => void;
}

class NativeToolProtocolVersionError extends Error {
    readonly toolName: string;
    readonly expectedVersion: number;
    readonly actualVersion: string;

    constructor(toolName: string, expectedVersion: number, actualVersion: string) {
        super(`${toolName} unsupported native protocol version: expected ${expectedVersion}, got ${actualVersion}`);
        this.name = 'NativeToolProtocolVersionError';
        this.toolName = toolName;
        this.expectedVersion = expectedVersion;
        this.actualVersion = actualVersion;
    }
}

const NATIVE_TOOL_PROTOCOL_VERSION_TIMEOUT_MS = 5_000;
const expectedNativeToolProtocolVersions = new Map<string, number>([
    [
        'evb-pdf-image-combine',
        1,
    ],
    [
        'evb-pdf-page-ops',
        1,
    ],
    [
        'evb-pdf-search',
        1,
    ],
]);
const nativeToolProtocolHandshakeCache = new Map<string, Promise<void>>();

export async function runNativeToolCommand(
    command: string,
    args: string[],
    options: IRunNativeToolCommandOptions = {},
): Promise<IProcessResult> {
    await verifyNativeToolProtocol(command, options);
    return runNativeCommand(command, args, createBaseRunCommandOptions(options));
}

async function verifyNativeToolProtocol(command: string, options: IRunNativeToolCommandOptions) {
    const toolName = getNativeToolName(command);
    if (toolName === null) {
        return;
    }

    const cachedHandshake = nativeToolProtocolHandshakeCache.get(command);
    if (cachedHandshake) {
        await cachedHandshake;
        return;
    }

    const handshake = runNativeToolProtocolHandshake(command, toolName, options);
    nativeToolProtocolHandshakeCache.set(command, handshake);
    await handshake;
}

function getNativeToolName(command: string) {
    const baseName = basename(command).toLowerCase();
    const toolName = baseName.endsWith('.exe') ? baseName.slice(0, -4) : baseName;
    return toolName.startsWith('evb-') ? toolName : null;
}

async function runNativeToolProtocolHandshake(
    command: string,
    toolName: string,
    options: IRunNativeToolCommandOptions,
) {
    const expectedVersion = expectedNativeToolProtocolVersions.get(toolName);
    if (expectedVersion === undefined) {
        throw new NativeToolProtocolVersionError(toolName, -1, 'unknown tool');
    }

    const commandOptions = createBaseRunCommandOptions(options);
    commandOptions.timeoutMs = NATIVE_TOOL_PROTOCOL_VERSION_TIMEOUT_MS;
    commandOptions.commandLabel = `${toolName}(protocol-version)`;
    commandOptions.maxStdoutBytes = 128;
    commandOptions.maxStderrBytes = 4_096;
    commandOptions.allowedExitCodes = [0];
    const result = await runNativeCommand(command, ['--protocol-version'], commandOptions);
    const actualVersionText = result.stdout.trim();
    const actualVersion = Number.parseInt(actualVersionText, 10);
    if (!Number.isSafeInteger(actualVersion) || actualVersion.toString() !== actualVersionText || actualVersion !== expectedVersion) {
        throw new NativeToolProtocolVersionError(toolName, expectedVersion, actualVersionText || '<empty>');
    }
}

function createBaseRunCommandOptions(options: IRunNativeToolCommandOptions): IRunCommandOptions {
    const {
        cwd,
        env,
        timeoutMs,
        maxStdoutBytes,
        maxStderrBytes,
        rejectOnStdoutTruncation,
        allowedExitCodes,
        signal,
        cancelGroup,
        commandLabel,
        log,
    } = options;

    const commandOptions: IRunCommandOptions = {
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
    };
    if (cwd !== undefined) {
        commandOptions.cwd = cwd;
    }
    if (env !== undefined) {
        commandOptions.env = env;
    }
    if (timeoutMs !== undefined) {
        commandOptions.timeoutMs = timeoutMs;
    }
    if (maxStdoutBytes !== undefined) {
        commandOptions.maxStdoutBytes = maxStdoutBytes;
    }
    if (maxStderrBytes !== undefined) {
        commandOptions.maxStderrBytes = maxStderrBytes;
    }
    if (rejectOnStdoutTruncation !== undefined) {
        commandOptions.rejectOnStdoutTruncation = rejectOnStdoutTruncation;
    }
    if (allowedExitCodes !== undefined) {
        commandOptions.allowedExitCodes = allowedExitCodes;
    }
    if (signal !== undefined) {
        commandOptions.signal = signal;
    }
    if (cancelGroup !== undefined) {
        commandOptions.cancelGroup = cancelGroup;
    }
    if (commandLabel !== undefined) {
        commandOptions.commandLabel = commandLabel;
    }
    if (log !== undefined) {
        commandOptions.log = log;
    }

    return commandOptions;
}
