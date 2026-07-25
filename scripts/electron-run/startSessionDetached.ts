import {
    closeSync,
    mkdirSync,
    openSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { delay } from 'es-toolkit/promise';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    cleanupStaleSessionArtifacts,
    cleanupSessionStartingAttempt,
    isSessionRunning,
    isSessionStarting,
    readSessionLogTail,
    waitForSessionReady,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    getCurrentSessionName,
    sessionDir,
    sessionLogFilePath,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    INITIAL_OPEN_PATHS_ENV,
    normalizeInitialOpenPaths,
} from '@scripts/electron-run/electronLaunch';

const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export async function startSessionDetached(options: {
    env?: NodeJS.ProcessEnv;
    owner?: 'dev' | 'e2e';
    initialOpenPaths?: string[];
} = {}) {
    await cleanupStaleSessionArtifacts();

    if (await isSessionRunning()) {
        console.log(`Session '${getCurrentSessionName()}' already running.`);
        return;
    }
    if (isSessionStarting()) {
        console.log(`Session '${getCurrentSessionName()}' startup already in progress. Waiting for readiness...`);
        const ready = await waitForSessionReady(90_000);
        if (!ready) {
            throw new Error(`Startup is still pending. Check logs: ${sessionLogFilePath()}`);
        }
        console.log('Session is ready.');
        return;
    }

    mkdirSync(sessionDir(), { recursive: true });
    const logFd = openSync(sessionLogFilePath(), 'w');
    const isEphemeral = options.owner === 'e2e';
    const command = isEphemeral ? process.execPath : PNPM_COMMAND;
    const args = isEphemeral
        ? [
            '--import',
            'tsx',
            'scripts/electron-run/ephemeralSessionEntry.ts',
            getCurrentSessionName(),
        ]
        : [
            'electron:run',
            `--session=${getCurrentSessionName()}`,
            'start',
        ];
    const child = spawn(command, args, {
        cwd: projectRoot,
        detached: true,
        shell: false,
        stdio: [
            'ignore',
            logFd,
            logFd,
        ],
        env: {
            ...process.env,
            ...options.env,
            ...(options.initialOpenPaths
                ? { [INITIAL_OPEN_PATHS_ENV]: JSON.stringify(normalizeInitialOpenPaths(options.initialOpenPaths)) }
                : {}),
        },
    });
    closeSync(logFd);
    child.unref();

    const timeoutMs = 120_000;
    const start = Date.now();
    let ready = false;
    while (Date.now() - start < timeoutMs) {
        if (await isSessionRunning()) {
            ready = true;
            break;
        }
        if (child.pid && !isProcessAlive(child.pid) && !isSessionStarting()) {
            break;
        }
        await delay(300);
    }
    if (!ready) {
        if (child.pid && isProcessAlive(child.pid)) {
            await killProcessTree(child.pid, 1500);
        }
        await cleanupSessionStartingAttempt();
        const tail = readSessionLogTail();
        const details = tail ? `\n\n--- Recent session log ---\n${tail}` : '';
        throw new Error(`Detached session failed to become ready in ${Math.round(timeoutMs / 1000)}s. Check logs: ${sessionLogFilePath()}${details}`);
    }

    console.log(`Session '${getCurrentSessionName()}' started in background (pid: ${child.pid ?? 'unknown'}).`);
    console.log(`Logs: ${sessionLogFilePath()}`);
}
