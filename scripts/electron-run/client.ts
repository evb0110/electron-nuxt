import { delay } from 'es-toolkit/promise';
import {
    COMMAND_REQUEST_TIMEOUT_MS,
    SESSION_WAIT_TIMEOUT_MS,
    getCurrentSessionName,
    getSessionInfo,
    parseElectronRunCommandResponse,
    type TElectronRunCommand,
} from './shared';

export async function sendCommand(
    command: TElectronRunCommand,
    args: unknown[] = [],
    requestTimeoutMs = COMMAND_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
    const start = Date.now();
    let didPrintWaitMessage = false;

    while (Date.now() - start < SESSION_WAIT_TIMEOUT_MS) {
        const info = getSessionInfo();

        if (!info) {
            if (!didPrintWaitMessage && Date.now() - start > 2000) {
                didPrintWaitMessage = true;
                console.log(`[Session '${getCurrentSessionName()}'] Waiting for session to start...`);
            }
            await delay(250);
            continue;
        }

        let data: ReturnType<typeof parseElectronRunCommandResponse> = null;

        try {
            const res = await fetch(`http://localhost:${info.port}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    command,
                    args, 
                }),
                signal: AbortSignal.timeout(requestTimeoutMs),
            });
            data = parseElectronRunCommandResponse(await res.json());
            if (!data) {
                throw new Error('Session returned malformed response payload');
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`Command "${command}" timed out after ${Math.round(requestTimeoutMs / 1000)}s`);
            }
            if (!didPrintWaitMessage) {
                didPrintWaitMessage = true;
                console.log(`[Session '${getCurrentSessionName()}'] Waiting for session to become ready...`);
            }
            await delay(250);
            continue;
        }

        if (!data.success) {
            throw new Error(data.error ?? 'Unknown error');
        }

        return data.result;
    }

    throw new Error(`Session '${getCurrentSessionName()}' not ready after ${Math.round(SESSION_WAIT_TIMEOUT_MS / 1000)}s. Start with: pnpm electron:run start --session=${getCurrentSessionName()}`);
}
