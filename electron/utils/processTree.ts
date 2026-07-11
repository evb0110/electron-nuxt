import { spawn } from 'child_process';
import { clamp } from 'es-toolkit/math';
import { delay } from 'es-toolkit/promise';

interface ITerminateProcessTreeOptions {
    graceMs?: number;
    isTargetAlive?: () => boolean;
    platform?: NodeJS.Platform;
    preferProcessGroup?: boolean;
    taskkillTimeoutMs?: number;
}

const DEFAULT_GRACE_MS = 2_500;
const DEFAULT_TASKKILL_TIMEOUT_MS = 2_000;

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

function killTaskkillHelper(child: ReturnType<typeof spawn>) {
    try {
        child.kill();
    } catch {
        // taskkill may have already exited.
    }
}

async function runTaskkill(pid: number, force: boolean, timeoutMs: number) {
    await new Promise<void>((resolve) => {
        let settled = false;
        let timeoutHandle: NodeJS.Timeout | null = null;
        const settle = () => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            resolve();
        };
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

        timeoutHandle = setTimeout(() => {
            killTaskkillHelper(child);
            settle();
        }, Math.max(0, timeoutMs));
        timeoutHandle.unref?.();

        child.once('error', settle);
        child.once('close', settle);
    });
}

export async function terminateProcessTree(
    pid: number,
    options: ITerminateProcessTreeOptions = {},
) {
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const isTargetAlive = options.isTargetAlive ?? (() => true);
    const platform = options.platform ?? process.platform;
    const preferProcessGroup = options.preferProcessGroup ?? false;
    const taskkillTimeoutMs = options.taskkillTimeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS;

    if (!isTargetAlive() || !isPidAlive(pid)) {
        return;
    }

    if (platform === 'win32') {
        await runTaskkill(pid, false, taskkillTimeoutMs);
        const exitedGracefully = await waitForExit(pid, graceMs);
        if (!exitedGracefully && isTargetAlive() && isPidAlive(pid)) {
            await runTaskkill(pid, true, taskkillTimeoutMs);
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
    if (exitedGracefully || !stillAlive || !isTargetAlive()) {
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
