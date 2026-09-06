import {
    accessSync,
    constants,
    existsSync,
} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {
    join,
    resolve,
} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    platform,
    arch,
} from 'node:process';

const NATIVE_PAGE_OPS_PROJECTS = new Set([
    'e2e-blocking-smoke',
    'e2e-draw-shapes',
    'e2e-large-pdf',
    'e2e-native-save-reopen',
    'e2e-regression',
    'e2e-save-pipeline',
    'e2e-xlarge-pdf',
]);

function platformArch() {
    const platformName = platform === 'win32' ? 'win32' : platform;
    return `${platformName}-${arch}`;
}

function nativeToolCandidates(projectRoot) {
    const binaryName = platform === 'win32' ? 'evb-pdf-page-ops.exe' : 'evb-pdf-page-ops';
    const tag = platformArch();
    return [
        process.env.EVB_PDF_PAGE_OPS_PATH,
        join(projectRoot, '.tmp', 'pdf-page-ops', tag, 'bin', binaryName),
        join(projectRoot, 'native', 'target', 'release', binaryName),
        join(projectRoot, 'native', 'target', 'debug', binaryName),
    ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
}

function findExecutable(projectRoot) {
    return nativeToolCandidates(projectRoot).find((candidate) => {
        if (!existsSync(candidate)) {
            return false;
        }
        try {
            accessSync(candidate, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }) ?? null;
}

/**
 * @param {{
 *     project?: string;
 *     projectRoot?: string;
 *     env?: Record<string, string | undefined>;
 * }} options
 */
export function assertElectronNativePageOps({
    project,
    projectRoot = process.cwd(),
    env = process.env,
} = {}) {
    if (!NATIVE_PAGE_OPS_PROJECTS.has(project)) {
        return {
            required: false,
            disabled: false,
            toolPath: null,
        };
    }

    if (env.EVB_PDF_PAGE_OPS_DISABLE === '1') {
        return {
            required: true,
            disabled: true,
            toolPath: null,
        };
    }

    if (env.EVB_PDF_PAGE_OPS_ENABLE !== '1') {
        throw new Error(
            `Native PDF page operations are required for ${project}; `
            + 'the launcher did not set EVB_PDF_PAGE_OPS_ENABLE=1.',
        );
    }

    const toolPath = findExecutable(resolve(projectRoot));
    if (!toolPath) {
        throw new Error(
            `Native PDF page operations are required for ${project}, but `
            + 'evb-pdf-page-ops was not found in EVB_PDF_PAGE_OPS_PATH, .tmp, '
            + 'native/target/release, or native/target/debug.',
        );
    }

    try {
        execFileSync(toolPath, ['--version'], {stdio: 'pipe'});
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Native PDF page operations failed its --version check at ${toolPath}: ${detail}`);
    }

    return {
        required: true,
        disabled: false,
        toolPath,
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const project = process.argv[2];
    try {
        const result = assertElectronNativePageOps({project});
        if (result.required && !result.disabled) {
            console.log(`[native-page-ops] admitted ${project}: ${result.toolPath}`);
        }
    } catch (error) {
        console.error(`[native-page-ops] admission failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
