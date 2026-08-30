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
    onSpawn?: (pid: number) => void;
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
interface IProtocolHandshake {
    controller: AbortController;
    promise: Promise<void>;
    waiters: number;
}

const nativeToolProtocolHandshakeCache = new Map<string, IProtocolHandshake>();

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

    const controller = new AbortController();
    const handshake: IProtocolHandshake = {
        controller,
        promise: runNativeToolProtocolHandshake(command, toolName, options, controller.signal)
            .catch((error: unknown) => {
                if (nativeToolProtocolHandshakeCache.get(command) === handshake) {
                    nativeToolProtocolHandshakeCache.delete(command);
                }
                throw error;
            }),
        waiters: 0,
    };
    nativeToolProtocolHandshakeCache.set(command, handshake);
    await waitForProtocolHandshake(handshake, options.signal);
}

function waitForProtocolHandshake(handshake: IProtocolHandshake, signal: AbortSignal | undefined) {
    handshake.waiters += 1;
    let released = false;
    const release = () => {
        if (released) {
            return;
        }
        released = true;
        handshake.waiters -= 1;
        if (handshake.waiters === 0 && !handshake.controller.signal.aborted) {
            handshake.controller.abort(new Error('All native tool protocol callers canceled'));
        }
    };
    if (signal === undefined) {
        return handshake.promise.finally(release);
    }
    if (signal.aborted) {
        release();
        return Promise.reject(abortErrorFromSignal(signal));
    }

    return new Promise<void>((resolve, reject) => {
        const handleAbort = () => {
            signal.removeEventListener('abort', handleAbort);
            release();
            reject(abortErrorFromSignal(signal));
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        void handshake.promise.then(
            () => {
                signal.removeEventListener('abort', handleAbort);
                release();
                resolve();
            },
            (error: unknown) => {
                signal.removeEventListener('abort', handleAbort);
                release();
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
    signal: AbortSignal,
) {
    const expectedVersion = expectedNativeToolProtocolVersions.get(toolName);
    if (expectedVersion === undefined) {
        throw new NativeToolProtocolVersionError(toolName, -1, 'unknown tool');
    }

    const commandOptions = createProtocolHandshakeCommandOptions(options, signal);
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

function createProtocolHandshakeCommandOptions(options: IRunNativeToolCommandOptions, signal: AbortSignal): IRunCommandOptions {
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
    handshakeOptions.signal = signal;
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
