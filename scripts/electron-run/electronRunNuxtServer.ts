import {
    execFileSync,
    spawn,
    type ChildProcess,
} from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { uniq } from 'es-toolkit/array';
import { delay } from 'es-toolkit/promise';
import { buildNuxtDevServerEnv } from '@scripts/electron-run/electronRunLaunchConfig';
import { isReusableNuxtResponse } from '@scripts/electron-run/isReusableNuxtResponse';
import {
    DEFAULT_NUXT_PORT,
    getNuxtPort,
    setNuxtPort,
} from '@scripts/electron-run/electronRunPortConfig';
import {
    collectDescendantPidsUnix,
    findFreePort,
    getPidsOnPort,
    isProcessAlive,
    killPids,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    getSessionInfo,
    listAllSessionNames,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import { getCurrentSessionName } from '@scripts/electron-run/electronRunSessionPaths';

export const ELECTRON_SERVER_PATH = '/electron';

const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function formatElapsedMs(startedAt: number) {
    return `${((Date.now() - startedAt) / 1000).toFixed(2)}s`;
}

function createStartupLogger(startedAt = Date.now()) {
    return (message: string) => {
        console.log(`[Startup +${formatElapsedMs(startedAt)}] ${message}`);
    };
}

async function killProcessTreeForPids(pids: number[], graceMs = 1200) {
    for (const pid of uniq(pids)) {
        await killProcessTree(pid, graceMs);
    }
}

function getDescendantPids(rootPid: number) {
    if (!Number.isFinite(rootPid) || rootPid <= 0 || process.platform === 'win32') {
        return [] as number[];
    }

    return collectDescendantPidsUnix(rootPid);
}

export function getElectronAppUrl() {
    return `http://127.0.0.1:${getNuxtPort()}${ELECTRON_SERVER_PATH}`;
}

async function isNuxtRunning() {
    try {
        const res = await fetch(`http://127.0.0.1:${getNuxtPort()}`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(500),
        });
        return res.ok;
    } catch {
        return false;
    }
}

async function isReusableNuxtServerReady() {
    if (!await isNuxtRunning()) {
        return false;
    }
    return isReusableNuxtServer();
}

async function isReusableNuxtServer() {
    try {
        const res = await fetch(`http://127.0.0.1:${getNuxtPort()}${ELECTRON_SERVER_PATH}`, {
            method: 'GET',
            signal: AbortSignal.timeout(1000),
        });
        if (!res.ok) {
            return false;
        }
        const poweredBy = res.headers.get('x-powered-by')?.toLowerCase() ?? '';
        const text = await res.text();
        return isReusableNuxtResponse({
            poweredBy,
            body: text,
        });
    } catch {
        return false;
    }
}

export async function waitForReusableNuxtServer(timeoutMs: number) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isReusableNuxtServer()) {
            return true;
        }
        await delay(250);
    }
    return false;
}

export async function killExistingNuxt() {
    try {
        const pids = getPidsOnPort(getNuxtPort());
        await killProcessTreeForPids(pids, 1200);
        killPids(pids);
        await delay(500);
    } catch {}
}

function clearViteCache() {
    const cachePaths = [
        join(projectRoot, 'node_modules', '.vite'),
        join(projectRoot, 'node_modules', '.cache', 'vite'),
        join(projectRoot, '.nuxt'),
    ];

    for (const cachePath of cachePaths) {
        try {
            rmSync(cachePath, {
                recursive: true,
                force: true,
            });
            console.log(`[Cache] Cleared ${cachePath.replace(projectRoot + '/', '')}`);
        } catch {}
    }
}

async function cleanupStaleNuxtPortOwners(reason: string) {
    const nuxtPort = getNuxtPort();
    const pidsOnPort = getPidsOnPort(nuxtPort);
    if (pidsOnPort.length === 0) {
        return false;
    }

    const sessionMetadata: INuxtPortOwnerSessionMetadata[] = [];
    for (const name of listAllSessionNames()) {
        const info = getSessionInfo(name);
        if (!info) {
            continue;
        }
        const nuxtPid = info?.nuxtPid ?? null;
        const nuxtAlive = Boolean(nuxtPid && isProcessAlive(nuxtPid));
        sessionMetadata.push({
            name,
            sessionPid: info.pid,
            nuxtPid,
            nuxtPort: info.nuxtPort,
            sessionAlive: isProcessAlive(info.pid),
            nuxtAlive,
            descendantPids: nuxtAlive && nuxtPid ? getDescendantPids(nuxtPid) : [],
        });
    }

    const staleNuxtPids = selectStaleNuxtPortOwnerCleanupTargets(
        pidsOnPort,
        sessionMetadata,
        nuxtPort,
    );
    if (staleNuxtPids.length === 0) {
        return false;
    }

    console.log(`[Nuxt] Cleaning stale session-owned Nuxt process(es) on port ${nuxtPort} (${reason}): ${staleNuxtPids.join(', ')}`);
    await killProcessTreeForPids(staleNuxtPids, 1200);
    killPids(staleNuxtPids);
    await delay(500);
    return true;
}

interface IProcessListEntry {
    pid: number;
    ppid: number;
    command: string;
}

function listUnixProcesses(): IProcessListEntry[] {
    if (process.platform === 'win32') {
        return [];
    }

    try {
        const output = execFileSync('ps', [
            '-ax',
            '-o',
            'pid=,ppid=,command=',
        ], {encoding: 'utf8'});
        const processes: IProcessListEntry[] = [];
        for (const line of output.split('\n')) {
            const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
            if (!match) {
                continue;
            }
            const pid = Number(match[1]);
            const ppid = Number(match[2]);
            const command = match[3] ?? '';
            if (Number.isFinite(pid) && Number.isFinite(ppid) && pid > 0 && ppid > 0) {
                processes.push({
                    pid,
                    ppid,
                    command,
                });
            }
        }
        return processes;
    } catch {
        return [];
    }
}

function getProcessCwd(pid: number) {
    if (process.platform === 'win32') {
        return null;
    }

    try {
        const output = execFileSync('lsof', [
            '-a',
            '-p',
            String(pid),
            '-d',
            'cwd',
            '-Fn',
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        });
        const cwdLine = output.split('\n').find(line => line.startsWith('n'));
        return cwdLine ? cwdLine.slice(1) : null;
    } catch {
        return null;
    }
}

function getProcessEnvValue(pid: number, name: string) {
    if (process.platform === 'win32') {
        return null;
    }

    try {
        const output = execFileSync('ps', [
            'eww',
            '-p',
            String(pid),
            '-o',
            'command=',
        ], {encoding: 'utf8'});
        const prefix = `${name}=`;
        const token = output.split(/\s+/).find(part => part.startsWith(prefix));
        return token ? token.slice(prefix.length) : null;
    } catch {
        return null;
    }
}

function getProcessEnvPort(pid: number) {
    const port = Number(getProcessEnvValue(pid, 'PORT'));
    return Number.isInteger(port) && port > 0 ? port : null;
}

function isProjectNuxtRootProcess(processEntry: IProcessListEntry) {
    if (!processEntry.command.includes('pnpm run dev:nuxt')) {
        return false;
    }
    return getProcessCwd(processEntry.pid) === projectRoot;
}

function getProjectNuxtRootProcesses(): IProjectNuxtRootProcessMetadata[] {
    return listUnixProcesses()
        .filter(isProjectNuxtRootProcess)
        .map(processEntry => ({
            pid: processEntry.pid,
            ppid: processEntry.ppid,
            devServerPort: getProcessEnvPort(processEntry.pid),
            descendantPids: getDescendantPids(processEntry.pid),
        }));
}

export async function cleanupOrphanedProjectNuxtRoots(reason: string) {
    const roots = getProjectNuxtRootProcesses();
    if (roots.length === 0) {
        return false;
    }

    const pidsOnPreservedPort = getPidsOnPort(getNuxtPort());
    const targets = selectOrphanedProjectNuxtRootCleanupTargets(roots, pidsOnPreservedPort, getNuxtPort());
    if (targets.length === 0) {
        return false;
    }

    console.log(`[Nuxt] Cleaning orphaned project dev server root(s) (${reason}): ${targets.join(', ')}`);
    await killProcessTreeForPids(targets, 1200);
    killPids(targets);
    await delay(500);
    return true;
}

interface INuxtStartupAttempt {
    nuxt: ChildProcess;
    viteClientBuilt: boolean;
    viteServerBuilt: boolean;
    nitroBuilt: boolean;
    viteClientWarmed: boolean;
    sawPortCollision: boolean;
    exited: boolean;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
}

export interface INuxtPortOwnerSessionMetadata {
    name: string;
    sessionPid: number | null;
    nuxtPid: number | null;
    nuxtPort: number;
    sessionAlive: boolean;
    nuxtAlive: boolean;
    descendantPids: number[];
}

export interface IProjectNuxtRootProcessMetadata {
    pid: number;
    ppid: number;
    devServerPort: number | null;
    descendantPids: number[];
}

export interface INuxtSessionShareMetadata {
    name: string;
    sessionAlive: boolean;
    nuxtPid: number | null;
    nuxtPort: number;
}

export function hasOtherAliveSessionUsingNuxt(
    sessions: INuxtSessionShareMetadata[],
    currentName: string,
    nuxtPid: number,
    nuxtPort: number,
) {
    return sessions.some(session =>
        session.name !== currentName
        && session.sessionAlive
        && (
            session.nuxtPid === nuxtPid
            || session.nuxtPort === nuxtPort
        ),
    );
}

export function selectStaleNuxtPortOwnerCleanupTargets(
    pidsOnPort: number[],
    sessions: INuxtPortOwnerSessionMetadata[],
    nuxtPort: number,
) {
    const targets = new Set<number>();
    for (const session of sessions) {
        if (
            session.sessionAlive
            || session.nuxtPort !== nuxtPort
            || !session.nuxtPid
            || !session.nuxtAlive
        ) {
            continue;
        }

        const ownedPids = new Set([
            session.nuxtPid,
            ...session.descendantPids,
        ]);
        if (pidsOnPort.some(pid => ownedPids.has(pid))) {
            targets.add(session.nuxtPid);
        }
    }

    return Array.from(targets);
}

export function selectOrphanedProjectNuxtRootCleanupTargets(
    roots: IProjectNuxtRootProcessMetadata[],
    pidsOnPreservedPort: number[],
    devServerPort: number,
) {
    const preservedPids = new Set(pidsOnPreservedPort);
    const targets = new Set<number>();

    for (const root of roots) {
        if (root.ppid !== 1) {
            continue;
        }

        const ownedPids = new Set([
            root.pid,
            ...root.descendantPids,
        ]);
        const ownsPreservedDevServer = root.devServerPort === devServerPort
            && Array.from(preservedPids).some(pid => ownedPids.has(pid));
        if (ownsPreservedDevServer) {
            continue;
        }

        targets.add(root.pid);
    }

    return Array.from(targets);
}

function hasCompletedNuxtBuildMarkers(attempt: INuxtStartupAttempt) {
    return attempt.viteClientBuilt && attempt.viteServerBuilt && attempt.nitroBuilt;
}

function getMissingNuxtBuildLabels(attempt: INuxtStartupAttempt) {
    const missing = [];
    if (!attempt.viteClientBuilt) {
        missing.push('Vite client');
    }
    if (!attempt.viteServerBuilt) {
        missing.push('Vite server');
    }
    if (!attempt.nitroBuilt) {
        missing.push('Nitro');
    }
    if (!attempt.viteClientWarmed) {
        missing.push('Vite warmup');
    }
    return missing;
}

async function selectNuxtPort() {
    const isDefaultSession = getCurrentSessionName() === 'default';
    if (isDefaultSession) {
        setNuxtPort(DEFAULT_NUXT_PORT);
        console.log(`[Nuxt] Using fixed dev port ${getNuxtPort()}`);
        return;
    }

    setNuxtPort(await findFreePort());
    console.log(`[Nuxt] Using isolated port ${getNuxtPort()} for session '${getCurrentSessionName()}'`);
}

async function prepareNuxtServerStart(forceClean: boolean, logTiming: (message: string) => void) {
    await selectNuxtPort();
    console.log(`[Nuxt] Browser dev server: http://localhost:${getNuxtPort()}/`);
    await cleanupOrphanedProjectNuxtRoots('before reuse check');
    logTiming('Nuxt orphan cleanup complete');

    if (!forceClean && await isReusableNuxtServerReady()) {
        console.log(`[Nuxt] Reusing existing dev server at http://127.0.0.1:${getNuxtPort()}`);
        logTiming('Nuxt existing dev server reused');
        return false;
    }

    await cleanupStaleNuxtPortOwners('before start');
    logTiming('Nuxt port cleanup complete');

    if (forceClean) {
        console.log('[Nuxt] Force clean start...');
        clearViteCache();
        logTiming('Nuxt cache cleanup complete');
    }

    return true;
}

function updateNuxtStartupMarkers(
    attempt: INuxtStartupAttempt,
    text: string,
    logTiming: (message: string) => void,
) {
    if (text.includes('Vite client built')) {
        console.log('[Nuxt] Vite client built');
        logTiming('Nuxt Vite client built');
        attempt.viteClientBuilt = true;
    }
    if (text.includes('Vite server built')) {
        console.log('[Nuxt] Vite server built');
        logTiming('Nuxt Vite server built');
        attempt.viteServerBuilt = true;
    }
    if (text.includes('Nitro server built') || text.includes('Nitro') && text.includes('built')) {
        console.log('[Nuxt] Nitro server built');
        logTiming('Nuxt Nitro server built');
        attempt.nitroBuilt = true;
    }
    if (text.includes('Vite client warmed up')) {
        console.log('[Nuxt] Vite client warmed up');
        logTiming('Nuxt Vite client warmed up');
        attempt.viteClientWarmed = true;
    }
    const lowerText = text.toLowerCase();
    if (lowerText.includes('address already in use') || lowerText.includes('eaddrinuse')) {
        attempt.sawPortCollision = true;
    }
}

function spawnNuxtStartupAttempt(attemptIndex: number, logTiming: (message: string) => void): INuxtStartupAttempt {
    console.log(`[Nuxt] Starting dev server on port ${getNuxtPort()} (attempt ${attemptIndex + 1}/2)...`);
    const attempt: INuxtStartupAttempt = {
        nuxt: spawn(PNPM_COMMAND, [
            'run',
            'dev:nuxt',
        ], {
            cwd: projectRoot,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
            env: buildNuxtDevServerEnv(process.env, getNuxtPort()),
        }),
        viteClientBuilt: false,
        viteServerBuilt: false,
        nitroBuilt: false,
        viteClientWarmed: false,
        sawPortCollision: false,
        exited: false,
        exitCode: null,
        exitSignal: null,
    };

    attempt.nuxt.on('exit', (code, signal) => {
        attempt.exited = true;
        attempt.exitCode = code;
        attempt.exitSignal = signal;
    });

    const checkOutput = (data: Buffer) => updateNuxtStartupMarkers(attempt, data.toString(), logTiming);
    attempt.nuxt.stdout?.on('data', checkOutput);
    attempt.nuxt.stderr?.on('data', checkOutput);
    return attempt;
}

async function warmupElectronAppDependencies(logTiming: (message: string) => void) {
    console.log('[Nuxt] Warming up dependencies...');
    try {
        await fetch(getElectronAppUrl(), { method: 'GET' });
    } catch {}
    logTiming('Nuxt dependency warmup complete');
}

function createNuxtStartupExitError(attempt: INuxtStartupAttempt) {
    const pids = getPidsOnPort(getNuxtPort());
    const suffix = pids.length > 0 ? ` Port owners: ${pids.join(', ')}` : '';
    return new Error(
        `Nuxt process exited before startup completed (code=${attempt.exitCode ?? 'null'}, signal=${attempt.exitSignal ?? 'null'}).${suffix}`,
    );
}

async function maybeReuseUnrelatedNuxtServer(attempt: INuxtStartupAttempt) {
    const nuxtPid = attempt.nuxt.pid ?? null;
    if (!nuxtPid || nuxtPid <= 0) {
        return false;
    }

    const ownedPids = new Set<number>([
        nuxtPid,
        ...getDescendantPids(nuxtPid),
    ]);
    const pidsOnPort = getPidsOnPort(getNuxtPort());
    const ownsRespondingServer = pidsOnPort.some(pid => ownedPids.has(pid));
    if (pidsOnPort.length === 0 || ownsRespondingServer) {
        return false;
    }

    if (!await isReusableNuxtServerReady()) {
        return false;
    }

    console.log(`[Nuxt] Port ${getNuxtPort()} is already served by unrelated reusable Nuxt process(es): ${pidsOnPort.join(', ')}. Reusing existing server.`);
    if (isProcessAlive(nuxtPid)) {
        await killProcessTree(nuxtPid, 800);
    }
    return true;
}

function shouldRetryNuxtStartup(cleaned: boolean, attempt: INuxtStartupAttempt, attemptIndex: number) {
    return (cleaned || attempt.sawPortCollision) && attemptIndex === 0;
}

type TNuxtStartupResult =
    | {
        kind: 'ready';
        nuxt: ChildProcess | null;
    }
    | {kind: 'retry'};

async function waitForNuxtStartupAttempt(
    attempt: INuxtStartupAttempt,
    attemptIndex: number,
    logTiming: (message: string) => void,
): Promise<TNuxtStartupResult> {
    const timeout = 120_000;
    const WARMUP_GRACE_MS = 5_000;
    const start = Date.now();
    let lastLog = 0;

    while (Date.now() - start < timeout) {
        const serverUp = await isNuxtRunning();
        const buildsComplete = hasCompletedNuxtBuildMarkers(attempt);
        const warmupComplete = attempt.viteClientWarmed || (Date.now() - start > WARMUP_GRACE_MS);
        const elapsedMs = Date.now() - start;

        if (buildsComplete && warmupComplete) {
            if (!serverUp) {
                if (Date.now() - lastLog > 2_000) {
                    console.log('[Nuxt] Build markers complete; waiting for HTTP readiness.');
                    lastLog = Date.now();
                }
                await delay(250);
                continue;
            }

            console.log('[Nuxt] Server ready at http://127.0.0.1:' + getNuxtPort());
            logTiming('Nuxt server ready');
            await warmupElectronAppDependencies(logTiming);
            return {
                kind: 'ready',
                nuxt: attempt.nuxt,
            };
        }

        if (serverUp && elapsedMs > 15_000 && await isReusableNuxtServer()) {
            console.log('[Nuxt] Reusable server responded without full build markers; proceeding with existing readiness signal.');
            logTiming('Nuxt server ready from HTTP fallback');
            return {
                kind: 'ready',
                nuxt: attempt.nuxt,
            };
        }

        if (attempt.exited) {
            const cleaned = await cleanupStaleNuxtPortOwners('spawn process exited');
            if (shouldRetryNuxtStartup(cleaned, attempt, attemptIndex)) {
                return {kind: 'retry'};
            }
            throw createNuxtStartupExitError(attempt);
        }

        const now = Date.now();
        if (serverUp && !buildsComplete && now - lastLog > 5000) {
            if (await maybeReuseUnrelatedNuxtServer(attempt)) {
                return {
                    kind: 'ready',
                    nuxt: null,
                };
            }
            console.log(`[Nuxt] Waiting for builds: ${getMissingNuxtBuildLabels(attempt).join(', ')}`);
            lastLog = now;
        }

        await delay(500);
    }

    return {kind: 'retry'};
}

async function stopTimedOutNuxtAttempt(attempt: INuxtStartupAttempt) {
    if (attempt.nuxt.pid && isProcessAlive(attempt.nuxt.pid)) {
        await killProcessTree(attempt.nuxt.pid, 800);
    } else {
        attempt.nuxt.kill();
    }
}

export async function startNuxtServer(forceClean = false): Promise<ChildProcess | null> {
    const logTiming = createStartupLogger();
    if (!await prepareNuxtServerStart(forceClean, logTiming)) {
        return null;
    }

    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
        const attempt = spawnNuxtStartupAttempt(attemptIndex, logTiming);
        const result = await waitForNuxtStartupAttempt(attempt, attemptIndex, logTiming);
        if (result.kind === 'ready') {
            return result.nuxt;
        }

        await stopTimedOutNuxtAttempt(attempt);
        if (attemptIndex === 0 && await cleanupStaleNuxtPortOwners('startup timeout')) {
            continue;
        }
    }

    throw new Error('Nuxt server failed to start');
}
