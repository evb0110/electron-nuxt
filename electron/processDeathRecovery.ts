import type { ILogger } from '@electron/utils/createLogger';

export const PROCESS_SAFE_MODE_ARGUMENT = '--evb-safe-mode';
const GPU_CRASH_WINDOW_MS = 5 * 60 * 1_000;
const GPU_CRASH_RELAUNCH_THRESHOLD = 2;

interface IProcessSafeModeApp {commandLine: {appendSwitch(name: string): void};}

interface IChildProcessGoneDetails {
    type: string;
    reason: string;
    exitCode: number;
    name?: string;
    serviceName?: string;
}

/**
 * `serviceName` of the only Electron utility processes this app forks. Both
 * come from `runDocumentSaveUtilityProcess`, which is the single
 * `utilityProcess.fork` call site in the app, and both are read back here to
 * recognise the app's own teardown. Every other child process the app starts is
 * a Node `child_process`, which Chromium never reports through
 * `child-process-gone`.
 */
export const DOCUMENT_FINGERPRINT_SERVICE_NAME = 'EVB document fingerprint';
export const DOCUMENT_SAVE_SERVICE_NAME = 'EVB document save';

const APP_TERMINATED_UTILITY_IDENTITIES: ReadonlySet<string> = new Set([
    DOCUMENT_FINGERPRINT_SERVICE_NAME,
    DOCUMENT_SAVE_SERVICE_NAME,
]);

/**
 * Whether this death is an app-owned utility process that the app itself ended.
 *
 * `runDocumentSaveUtilityProcess` kills its child as ordinary teardown the
 * moment the worker has answered, so `killed` carries no fault signal for those
 * two identities. The test is deliberately an allowlist rather than "any killed
 * non-GPU process": a Utility process the app did not fork, a Zygote, a sandbox
 * helper or a plugin host is only ever killed by something outside the app, and
 * that is worth reporting.
 *
 * `utilityProcess.fork` documents its `serviceName` option as surfacing in the
 * `name` field of this event, while Chromium fills `serviceName` with the mojo
 * service identity. Both fields are matched so the rule does not depend on which
 * one a given Electron build populates.
 */
function isAppTerminatedUtilityProcess(details: IChildProcessGoneDetails) {
    if (details.type !== 'Utility' || details.reason !== 'killed') {
        return false;
    }
    return APP_TERMINATED_UTILITY_IDENTITIES.has(details.name ?? '')
        || APP_TERMINATED_UTILITY_IDENTITIES.has(details.serviceName ?? '');
}

export function configureProcessSafeMode(app: IProcessSafeModeApp, argv: string[]) {
    if (!argv.includes(PROCESS_SAFE_MODE_ARGUMENT)) {
        return false;
    }
    app.commandLine.appendSwitch('disable-gpu');
    return true;
}

export function createProcessDeathRecovery(options: {
    argv: string[];
    logger: Pick<ILogger, 'error' | 'warn'>;
    now?: () => number;
    requestSafeModeRelaunch: (args: string[]) => void;
}) {
    const now = options.now ?? Date.now;
    let gpuCrashTimestamps: number[] = [];
    let safeModeRelaunchRequested = false;

    function handleChildProcessGone(details: IChildProcessGoneDetails) {
        const identity = details.name ?? details.serviceName ?? details.type;
        const message = `[process-death] ${details.type} process gone (${identity}, reason=${details.reason}, exitCode=${details.exitCode})`;
        // Error level is what the renderer turns into a user-visible diagnostic
        // report, so leaving the app's own utility teardown there raised a
        // report for every successful fingerprint and every successful save.
        // The event still belongs in the log; only the channel changes. Every
        // other death, killed or not, keeps error level, including the GPU,
        // whose deaths drive the safe-mode relaunch below.
        if (isAppTerminatedUtilityProcess(details)) {
            options.logger.warn(message);
            return {action: 'logged' as const};
        }
        options.logger.error(message);
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
        if (safeModeRelaunchRequested) {
            return {action: 'safe-mode-relaunch-pending' as const};
        }

        const relaunchArgs = [
            ...options.argv.slice(1).filter(argument => argument !== PROCESS_SAFE_MODE_ARGUMENT),
            PROCESS_SAFE_MODE_ARGUMENT,
        ];
        safeModeRelaunchRequested = true;
        options.logger.warn('[process-death] Relaunching in software-rendering safe mode after repeated GPU crashes');
        options.requestSafeModeRelaunch(relaunchArgs);
        return {action: 'safe-mode-relaunch' as const};
    }

    return {handleChildProcessGone};
}
