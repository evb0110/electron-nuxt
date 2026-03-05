import { spawn } from 'child_process';
import { delay } from 'es-toolkit/promise';

interface ITerminateProcessTreeOptions {
    graceMs?: number;
    preferProcessGroup?: boolean;
}

const DEFAULT_GRACE_MS = 2_500;

function isPidAlive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForExit(pid: number, timeoutMs: number) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
        if (!isPidAlive(pid)) {
            return true;
        }
        await delay(100);
    }

    return !isPidAlive(pid);
}

function sendPosixSignal(
    pid: number,
    signal: NodeJS.Signals,
    preferProcessGroup: boolean,
) {
    try {
        if (preferProcessGroup) {
            process.kill(-pid, signal);
            return;
        }
    } catch {
        // Fall through to direct PID signaling.
    }

    try {
        process.kill(pid, signal);
    } catch {
        // Process may have already exited.
    }
}

async function runTaskkill(pid: number, force: boolean) {
    await new Promise<void>((resolve) => {
        const args = [
            '/PID',
            String(pid),
            '/T',
        ];
        if (force) {
            args.push('/F');
        }

        const child = spawn('taskkill', args, {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
        });

        child.once('error', () => resolve());
        child.once('close', () => resolve());
    });
}

export async function terminateProcessTree(
    pid: number,
    options: ITerminateProcessTreeOptions = {},
) {
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const preferProcessGroup = options.preferProcessGroup ?? false;

    if (!isPidAlive(pid)) {
        return;
    }

    if (process.platform === 'win32') {
        await runTaskkill(pid, false);
        const exitedGracefully = await waitForExit(pid, graceMs);
        if (!exitedGracefully && isPidAlive(pid)) {
            await runTaskkill(pid, true);
            const forceKillWaitMs = Math.min(2_000, Math.max(250, Math.floor(graceMs / 2)));
            await waitForExit(pid, forceKillWaitMs);
        }
        return;
    }

    sendPosixSignal(pid, 'SIGTERM', preferProcessGroup);
    const exitedGracefully = await waitForExit(pid, graceMs);
    if (exitedGracefully || !isPidAlive(pid)) {
        return;
    }

    sendPosixSignal(pid, 'SIGKILL', preferProcessGroup);
    const forceKillWaitMs = Math.min(2_000, Math.max(250, Math.floor(graceMs / 2)));
    await waitForExit(pid, forceKillWaitMs);
}
