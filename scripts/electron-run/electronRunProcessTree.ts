import { createServer as createNetServer } from 'node:net';
import { execSync } from 'node:child_process';
import { uniq } from 'es-toolkit/array';
import { delay } from 'es-toolkit/promise';

export async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createNetServer();
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                server.close();
                reject(new Error('Failed to allocate free port'));
                return;
            }
            const { port } = addr;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

export function getPidsOnPort(port: number): number[] {
    try {
        const output = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf8' });
        return output
            .split('\n')
            .map(entry => Number(entry.trim()))
            .filter(pid => Number.isFinite(pid) && pid > 0);
    } catch {
        return [];
    }
}

export function killPids(
    pids: number[],
    options: {
        signal?: NodeJS.Signals | number;
        exclude?: Set<number>;
    } = {},
) {
    if (!Array.isArray(pids) || pids.length === 0) {
        return;
    }
    const signal = options.signal ?? 'SIGKILL';
    const exclude = options.exclude ?? new Set<number>();
    exclude.add(process.pid);
    if (typeof process.ppid === 'number' && process.ppid > 0) {
        exclude.add(process.ppid);
    }

    const uniquePids = uniq(pids);
    for (const pid of uniquePids) {
        if (exclude.has(pid)) {
            continue;
        }
        try {
            process.kill(pid, signal);
        } catch {}
    }
}

export function collectDescendantPidsUnix(rootPid: number) {
    if (!Number.isFinite(rootPid) || rootPid <= 0) {
        return [];
    }

    try {
        const output = execSync('ps -eo pid=,ppid=', { encoding: 'utf8' });
        const childrenByParent = new Map<number, number[]>();

        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            const parts = trimmed.split(/\s+/);
            const pid = Number(parts[0]);
            const ppid = Number(parts[1]);
            if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid <= 0 || ppid <= 0) {
                continue;
            }
            const bucket = childrenByParent.get(ppid) ?? [];
            bucket.push(pid);
            childrenByParent.set(ppid, bucket);
        }

        const descendants: number[] = [];
        const stack = [rootPid];
        while (stack.length > 0) {
            const current = stack.pop()!;
            const children = childrenByParent.get(current) ?? [];
            for (const childPid of children) {
                descendants.push(childPid);
                stack.push(childPid);
            }
        }

        return descendants;
    } catch {
        return [];
    }
}

export function findPidsByCommandSubstring(substring: string) {
    const needle = substring.trim();
    if (!needle) {
        return [];
    }

    if (process.platform === 'win32') {
        return [];
    }

    try {
        const output = execSync('ps -ax -o pid=,command=', { encoding: 'utf8' });
        const pids: number[] = [];
        for (const line of output.split('\n')) {
            const match = line.match(/^\s*(\d+)\s+(.+)$/);
            if (!match) {
                continue;
            }
            const pid = Number(match[1]);
            const command = match[2];
            if (!Number.isFinite(pid) || pid <= 0) {
                continue;
            }
            if (!command) {
                continue;
            }
            if (command.includes(needle)) {
                pids.push(pid);
            }
        }
        return pids;
    } catch {
        return [];
    }
}

export async function killProcessTree(pid: number, graceMs = 1500) {
    if (!Number.isFinite(pid) || pid <= 0) {
        return;
    }
    if (!isProcessAlive(pid)) {
        return;
    }

    if (process.platform === 'win32') {
        try {
            execSync(`taskkill /PID ${pid} /T /F >NUL 2>&1`);
        } catch {}
        return;
    }

    const descendants = collectDescendantPidsUnix(pid);
    const targets = uniq([
        ...descendants,
        pid,
    ]);
    killPids(targets, { signal: 'SIGTERM' });

    if (graceMs > 0) {
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
            const alive = targets.some(targetPid => isProcessAlive(targetPid));
            if (!alive) {
                return;
            }
            await delay(80);
        }
    }

    const remaining = targets.filter(targetPid => isProcessAlive(targetPid));
    if (remaining.length > 0) {
        killPids(remaining, { signal: 'SIGKILL' });
    }
}

export async function killProcessTrees(pids: readonly number[], graceMs = 1200) {
    for (const pid of uniq(pids)) {
        await killProcessTree(pid, graceMs);
    }
}

export function isProcessAlive(pid: number) {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
