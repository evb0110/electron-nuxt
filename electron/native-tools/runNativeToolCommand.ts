import { basename } from 'node:path';
import {
    runNativeCommand,
    type IRunCommandOptions,
} from '@electron/native-tools/runNativeCommand';
import { withDefinedCommandOptions } from '@electron/native-tools/withDefinedCommandOptions';
import type { IProcessResult } from '@electron/native-tools/processResult';
import { GENERATED_RUST_NATIVE_TOOL_PROTOCOLS } from '@contracts/nativeToolProtocols';
import { abortErrorFromSignal } from '@electron/utils/abort';

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
    onStdout?: (chunk: string) => void;
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
const expectedNativeToolProtocolVersions = new Map<string, number>(
    GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.map(tool => [
        tool.binaryName,
        tool.protocolVersion,
    ]),
);
const nativeToolProtocolHandshakeCache = new Map<string, Promise<void>>();

export async function runNativeToolCommand(
    command: string,
    args: string[],
    options: IRunNativeToolCommandOptions = {},
): Promise<IProcessResult> {
    await verifyNativeToolProtocol(command, options);
    return runNativeCommand(command, args, createBaseRunCommandOptions(options));
}

export async function verifyNativeToolProtocol(command: string, options: IRunNativeToolCommandOptions = {}) {
    const toolName = getNativeToolName(command);
    if (toolName === null) {
        return;
    }
    if (options.signal?.aborted) {
        throw abortErrorFromSignal(options.signal);
    }

    const cachedHandshake = nativeToolProtocolHandshakeCache.get(command);
    if (cachedHandshake) {
        await waitForProtocolHandshake(cachedHandshake, options.signal);
        return;
    }

    const handshake = runNativeToolProtocolHandshake(command, toolName, options)
        .catch((error: unknown) => {
            if (nativeToolProtocolHandshakeCache.get(command) === handshake) {
                nativeToolProtocolHandshakeCache.delete(command);
            }
            throw error;
        });
    nativeToolProtocolHandshakeCache.set(command, handshake);
    await waitForProtocolHandshake(handshake, options.signal);
}

function waitForProtocolHandshake(handshake: Promise<void>, signal: AbortSignal | undefined) {
    if (signal === undefined) {
        return handshake;
    }
    if (signal.aborted) {
        return Promise.reject(abortErrorFromSignal(signal));
    }

    return new Promise<void>((resolve, reject) => {
        const handleAbort = () => {
            signal.removeEventListener('abort', handleAbort);
            reject(abortErrorFromSignal(signal));
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        void handshake.then(
            () => {
                signal.removeEventListener('abort', handleAbort);
                resolve();
            },
            (error: unknown) => {
                signal.removeEventListener('abort', handleAbort);
                reject(error);
            },
        );
    });
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

    const commandOptions = createProtocolHandshakeCommandOptions(options);
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

function createProtocolHandshakeCommandOptions(options: IRunNativeToolCommandOptions): IRunCommandOptions {
    const handshakeOptions: IRunNativeToolCommandOptions = {};
    if (options.cwd !== undefined) {
        handshakeOptions.cwd = options.cwd;
    }
    if (options.env !== undefined) {
        handshakeOptions.env = options.env;
    }
    if (options.log !== undefined) {
        handshakeOptions.log = options.log;
    }
    return createBaseRunCommandOptions(handshakeOptions);
}

function createBaseRunCommandOptions(options: IRunNativeToolCommandOptions): IRunCommandOptions {
    return withDefinedCommandOptions({
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
    }, options);
}
