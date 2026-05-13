import { delay } from 'es-toolkit/promise';
import {
    COMMAND_REQUEST_TIMEOUT_MS,
    SESSION_WAIT_TIMEOUT_MS,
} from './electronRunTimeouts';
import { getCurrentSessionName } from './electronRunSessionPaths';
import { getSessionInfo } from './electronRunSessionArtifacts';
import {
    parseElectronRunCommandResponse,
    type TElectronRunCommand,
} from './electronRunProtocol';
import type { ISessionInfo } from './electronRunSessionTypes';

async function postCommand(
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
        throw new Error('Session returned malformed response payload');
    }
    if (!data.success) {
        throw new Error(data.error ?? 'Unknown error');
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
): Promise<unknown> {
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
            return await postCommand(info, command, args, requestTimeoutMs);
        } catch (error) {
            if (isRequestTimeout(error)) {
                throw new Error(`Command "${command}" timed out after ${Math.round(requestTimeoutMs / 1000)}s`);
            }
            waitLogger.sessionReady();
            await delay(250);
            continue;
        }
    }

    throw new Error(`Session '${getCurrentSessionName()}' not ready after ${Math.round(SESSION_WAIT_TIMEOUT_MS / 1000)}s. Start with: pnpm electron:run start --session=${getCurrentSessionName()}`);
}
