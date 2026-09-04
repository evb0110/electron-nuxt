import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createNodeProcessSpawner,
    createOwnedProcessRegistry,
    createWindowsAppLauncher,
} from '@scripts/windows-test/guest/appLaunch';
import {
    guestLayoutForRoot,
    joinGuestPath,
    WINDOWS_GUEST_PATH_SEPARATOR,
} from '@scripts/windows-test/guest/guestPaths';
import {
    createNodeGuestCommandRunner,
    createNodeGuestFileSystem,
    nodeGuestClock,
} from '@scripts/windows-test/guest/guestRuntime';
import {
    runGuestWorker,
    type IGuestWorkerAdapters,
} from '@scripts/windows-test/guest/guestWorker';
import { createUia3PowerShellAdapter } from '@scripts/windows-test/guest/native-ui/uia3PowerShellAdapter';
import { createWinappCliAdapter } from '@scripts/windows-test/guest/native-ui/winappCliAdapter';
import { createPuppeteerViewerFactory } from '@scripts/windows-test/guest/viewer/createPuppeteerViewerFactory';

const DEFAULT_GUEST_ROOT = 'C:\\evb-test';

const DEFAULT_WAIT_FOR_JOB_MS = 15 * 60 * 1_000;

function parseWaitForJobMs(raw: string) {
    const parsed = Number(raw);
    if (raw.trim().length === 0 || !Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--wait-ms must be a non-negative integer of milliseconds, received "${raw}".`);
    }
    return parsed;
}

function nodeGuestWorkerAdapters(env: NodeJS.ProcessEnv): IGuestWorkerAdapters {
    return {
        createNativeUiAdapter: ({
            exec,
            clock,
            powerShell,
        }) => (env.EVB_WINDOWS_TEST_NATIVE_UI === 'uia3'
            ? createUia3PowerShellAdapter({
                powerShell,
                clock,
            })
            : createWinappCliAdapter({
                exec,
                clock,
                ...(env.EVB_WINDOWS_TEST_WINAPP_EXECUTABLE === undefined
                    ? {}
                    : { executable: env.EVB_WINDOWS_TEST_WINAPP_EXECUTABLE }),
            })),
        createViewerFactory: ({
            clock,
            paths,
            executable,
        }) => createPuppeteerViewerFactory({
            launcher: createWindowsAppLauncher({
                clock,
                spawner: createNodeProcessSpawner(),
                registry: createOwnedProcessRegistry(),
                executable,
            }),
            profileDirectory: paths.profileDir,
        }),
    };
}

export async function guestWorkerMain(argv: readonly string[], env: NodeJS.ProcessEnv) {
    const rootArgument = argv.find(argument => argument.startsWith('--root='));
    const root = rootArgument === undefined
        ? env.EVB_WINDOWS_TEST_GUEST_ROOT ?? DEFAULT_GUEST_ROOT
        : rootArgument.slice('--root='.length);
    const waitArgument = argv.find(argument => argument.startsWith('--wait-ms='));
    const layout = guestLayoutForRoot(root, WINDOWS_GUEST_PATH_SEPARATOR);
    const summary = await runGuestWorker({
        fs: createNodeGuestFileSystem(),
        exec: createNodeGuestCommandRunner(),
        clock: nodeGuestClock,
        paths: layout,
        adapters: nodeGuestWorkerAdapters(env),
        env,
        powerShellScriptsDirectory: joinGuestPath(
            WINDOWS_GUEST_PATH_SEPARATOR,
            layout.root,
            'worker',
            'powershell',
        ),
        waitForJobMs: waitArgument === undefined
            ? DEFAULT_WAIT_FOR_JOB_MS
            : parseWaitForJobMs(waitArgument.slice('--wait-ms='.length)),
    });
    process.stdout.write(`${JSON.stringify({
        resultFile: summary.resultFile,
        outcome: summary.result?.outcome ?? null,
        reason: summary.reason,
    }, null, 4)}\n`);
    return summary;
}

function canonicalPath(candidate: string) {
    try {
        return realpathSync(path.resolve(candidate));
    } catch {
        return null;
    }
}

const entryPath = process.argv[1] === undefined ? null : canonicalPath(process.argv[1]);
if (entryPath !== null && entryPath === canonicalPath(fileURLToPath(import.meta.url))) {
    void guestWorkerMain(process.argv.slice(2), process.env).then(
        (summary) => {
            process.exitCode = summary.result === null ? 1 : 0;
        },
        (error: unknown) => {
            process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
            process.exitCode = 1;
        },
    );
}
