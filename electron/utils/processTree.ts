import { spawn } from 'child_process';
import { clamp } from 'es-toolkit/math';
import { delay } from 'es-toolkit/promise';

interface ITerminateProcessTreeOptions {
    graceMs?: number;
    preferProcessGroup?: boolean;
}

const DEFAULT_GRACE_MS = 2_500;

interface IProcessTreeRuntime {
    delay: typeof delay;
    kill: typeof process.kill;
    now: () => number;
    spawn: typeof spawn;
}

// Keep runtime hooks narrow so tests can avoid mocking global process state.
export const processTreeRuntime = {
    delay,
    kill: process.kill.bind(process),
    now: () => Date.now(),
    spawn,
} satisfies IProcessTreeRuntime;

function isPidAlive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
    }

    try {
        processTreeRuntime.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isProcessGroupAlive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return false;
    }

    try {
        processTreeRuntime.kill(-pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForExit(pid: number, timeoutMs: number) {
    const deadline = processTreeRuntime.now() + Math.max(0, timeoutMs);
    while (processTreeRuntime.now() < deadline) {
        if (!isPidAlive(pid)) {
            return true;
        }
        await processTreeRuntime.delay(100);
    }

    return !isPidAlive(pid);
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number) {
    const deadline = processTreeRuntime.now() + Math.max(0, timeoutMs);
    while (processTreeRuntime.now() < deadline) {
        if (!isProcessGroupAlive(pid)) {
            return true;
        }
        await processTreeRuntime.delay(100);
    }

    return !isProcessGroupAlive(pid);
}

function sendPosixSignal(
    pid: number,
    signal: NodeJS.Signals,
    preferProcessGroup: boolean,
) {
    try {
        if (preferProcessGroup) {
            processTreeRuntime.kill(-pid, signal);
            return;
        }
    } catch {
        // Fall through to direct PID signaling.
    }

    try {
        processTreeRuntime.kill(pid, signal);
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

        const child = processTreeRuntime.spawn('taskkill', args, {
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
            const forceKillWaitMs = clamp(Math.floor(graceMs / 2), 250, 2_000);
            await waitForExit(pid, forceKillWaitMs);
        }
        return;
    }

    sendPosixSignal(pid, 'SIGTERM', preferProcessGroup);
    const exitedGracefully = preferProcessGroup
        ? await waitForProcessGroupExit(pid, graceMs)
        : await waitForExit(pid, graceMs);
    const stillAlive = preferProcessGroup
        ? isProcessGroupAlive(pid)
        : isPidAlive(pid);
    if (exitedGracefully || !stillAlive) {
        return;
    }

    sendPosixSignal(pid, 'SIGKILL', preferProcessGroup);
    const forceKillWaitMs = clamp(Math.floor(graceMs / 2), 250, 2_000);
    if (preferProcessGroup) {
        await waitForProcessGroupExit(pid, forceKillWaitMs);
    } else {
        await waitForExit(pid, forceKillWaitMs);
    }
}
