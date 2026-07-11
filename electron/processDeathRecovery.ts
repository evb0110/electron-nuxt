import type { ILogger } from '@electron/utils/createLogger';

export const PROCESS_SAFE_MODE_ARGUMENT = '--evb-safe-mode';
const GPU_CRASH_WINDOW_MS = 5 * 60 * 1_000;
const GPU_CRASH_RELAUNCH_THRESHOLD = 2;

interface IProcessRecoveryApp {
    commandLine: {appendSwitch(name: string): void};
    exit(code?: number): void;
    relaunch(options?: {args?: string[]}): void;
}

interface IChildProcessGoneDetails {
    type: string;
    reason: string;
    exitCode: number;
    name?: string;
    serviceName?: string;
}

export function configureProcessSafeMode(app: IProcessRecoveryApp, argv: string[]) {
    if (!argv.includes(PROCESS_SAFE_MODE_ARGUMENT)) {
        return false;
    }
    app.commandLine.appendSwitch('disable-gpu');
    return true;
}

export function createProcessDeathRecovery(options: {
    app: IProcessRecoveryApp;
    argv: string[];
    logger: Pick<ILogger, 'error' | 'warn'>;
    now?: () => number;
}) {
    const now = options.now ?? Date.now;
    let gpuCrashTimestamps: number[] = [];

    function handleChildProcessGone(details: IChildProcessGoneDetails) {
        const identity = details.name ?? details.serviceName ?? details.type;
        options.logger.error(
            `[process-death] ${details.type} process gone (${identity}, reason=${details.reason}, exitCode=${details.exitCode})`,
        );
        if (details.type !== 'GPU') {
            return {action: 'logged' as const};
        }

        const cutoff = now() - GPU_CRASH_WINDOW_MS;
        gpuCrashTimestamps = gpuCrashTimestamps.filter(timestamp => timestamp >= cutoff);
        gpuCrashTimestamps.push(now());
        if (gpuCrashTimestamps.length < GPU_CRASH_RELAUNCH_THRESHOLD) {
            return {action: 'logged' as const};
        }
        if (options.argv.includes(PROCESS_SAFE_MODE_ARGUMENT)) {
            options.logger.error('[process-death] GPU failed repeatedly while software-rendering safe mode was active');
            return {action: 'safe-mode-failed' as const};
        }

        const relaunchArgs = [
            ...options.argv.slice(1).filter(argument => argument !== PROCESS_SAFE_MODE_ARGUMENT),
            PROCESS_SAFE_MODE_ARGUMENT,
        ];
        options.logger.warn('[process-death] Relaunching in software-rendering safe mode after repeated GPU crashes');
        options.app.relaunch({args: relaunchArgs});
        options.app.exit(0);
        return {action: 'safe-mode-relaunch' as const};
    }

    return {handleChildProcessGone};
}
