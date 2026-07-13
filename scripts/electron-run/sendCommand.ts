import { delay } from 'es-toolkit/promise';
import {
    COMMAND_REQUEST_TIMEOUT_MS,
    SESSION_WAIT_TIMEOUT_MS,
} from '@scripts/electron-run/electronRunTimeouts';
import { getCurrentSessionName } from '@scripts/electron-run/electronRunSessionPaths';
import { getSessionInfo } from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    parseElectronRunCommandResponse,
    type TElectronRunCommand,
} from '@scripts/electron-run/electronRunProtocol';
import type { ISessionInfo } from '@scripts/electron-run/electronRunSessionTypes';

class ElectronRunCommandError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ElectronRunCommandError';
    }
}

export async function sendCommandToSession(
    info: ISessionInfo,
    command: TElectronRunCommand,
    args: unknown[],
    requestTimeoutMs: number,
) {
    const res = await fetch(`http://localhost:${info.port}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            command,
            args,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const data = parseElectronRunCommandResponse(await res.json());
    if (!data) {
        throw new ElectronRunCommandError('Session returned malformed response payload');
    }
    if (!data.success) {
        throw new ElectronRunCommandError(data.error ?? 'Unknown error');
    }
    return data.result;
}

function isRequestTimeout(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}

function createWaitLogger() {
    let didPrintWaitMessage = false;
    return {
        sessionStart(startedAt: number) {
            if (!didPrintWaitMessage && Date.now() - startedAt > 2000) {
                didPrintWaitMessage = true;
                console.log(`[Session '${getCurrentSessionName()}'] Waiting for session to start...`);
            }
        },
        sessionReady() {
            if (!didPrintWaitMessage) {
                didPrintWaitMessage = true;
                console.log(`[Session '${getCurrentSessionName()}'] Waiting for session to become ready...`);
            }
        },
    };
}

export async function sendCommand(
    command: TElectronRunCommand,
    args: unknown[] = [],
    requestTimeoutMs = COMMAND_REQUEST_TIMEOUT_MS,
) {
    const start = Date.now();
    const waitLogger = createWaitLogger();

    while (Date.now() - start < SESSION_WAIT_TIMEOUT_MS) {
        const info = getSessionInfo();

        if (!info) {
            waitLogger.sessionStart(start);
            await delay(250);
            continue;
        }

        try {
            return await sendCommandToSession(info, command, args, requestTimeoutMs);
        } catch (error) {
            if (isRequestTimeout(error)) {
                throw new Error(`Command "${command}" timed out after ${Math.round(requestTimeoutMs / 1000)}s`);
            }
            if (error instanceof ElectronRunCommandError) {
                throw error;
            }
            waitLogger.sessionReady();
            await delay(250);
            continue;
        }
    }

    throw new Error(`Session '${getCurrentSessionName()}' not ready after ${Math.round(SESSION_WAIT_TIMEOUT_MS / 1000)}s. Start with: pnpm electron:run start --session=${getCurrentSessionName()}`);
}
