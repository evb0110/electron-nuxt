import {
    createHash,
    randomBytes,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
    hostname,
    tmpdir,
} from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    WINDOWS_TEST_RUNNER_VERSION,
    windowsTestArchitectures,
    windowsTestExitCodes,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type { TWindowsTestSuite } from '@scripts/windows-test/contracts/windowsTestContracts';
import {loadFixtureManifest} from '@scripts/windows-test/fixtures/fixtureManifest';
import {
    resolveWindowsTestDataRoot,
    windowsTestHostLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    createCapabilityFileSuiteResolver,
    createFileFixtureManifestSource,
} from '@scripts/windows-test/host/capabilityRegistry';
import { createUtmctlGuestChannel } from '@scripts/windows-test/host/guestChannel';
import { createSystemClock } from '@scripts/windows-test/host/hostClock';
import {
    WindowsTestConfigError,
    describeMissingWindowsTestConfig,
    loadWindowsTestHostConfig,
} from '@scripts/windows-test/host/hostConfig';
import type {
    IWindowsTestCandidate,
    IWindowsTestHostConfig,
} from '@scripts/windows-test/host/hostConfig';
import {
    createLaunchctlSessionProbe,
    runWindowsTestDoctor,
} from '@scripts/windows-test/host/doctor';
import type { IWindowsTestDoctorReport } from '@scripts/windows-test/host/doctor';
import { createProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import { executeWindowsTestRun } from '@scripts/windows-test/host/runCoordinator';
import type {
    IWindowsTestRunReport,
    IWindowsTestStagedInput,
} from '@scripts/windows-test/host/runCoordinator';
import { requestWindowsTestStop } from '@scripts/windows-test/host/stopRun';
import type { IWindowsTestStopResult } from '@scripts/windows-test/host/stopRun';
import {
    createProcessCommandRunner,
    createUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';
import { loadWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';
import { createTestClone } from '@scripts/windows-test/images/createTestClone';
import { runWindowsHostOracles } from '@scripts/windows-test/oracles/windowsHostOracleDispatcher';

export const WINDOWS_TEST_CAPABILITY_REGISTRY_RELATIVE_PATH = path.join('tests', 'windows', 'capabilities.json');

export const WINDOWS_TEST_FIXTURE_MANIFEST_FILE_NAME = 'manifest.json';

export const WINDOWS_TEST_CANDIDATE_METADATA_SUFFIX = '.meta.json';

function fixtureFileName(relativePath: string) {
    const segments = relativePath.split(/[\\/]/u);
    const fileName = segments.at(-1);
    if (fileName === undefined || fileName.length === 0 || fileName === '.' || fileName === '..') {
        throw new Error(`Fixture path ${relativePath} does not name a file.`);
    }
    return fileName;
}

function resolveFixtureCachePath(manifestPath: string, relativePath: string) {
    const cacheRoot = path.dirname(manifestPath);
    const normalized = relativePath.split(/[\\/]/u).join(path.sep);
    const candidate = path.resolve(cacheRoot, normalized);
    const relative = path.relative(cacheRoot, candidate);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Fixture path ${relativePath} escapes the prepared fixture cache ${cacheRoot}.`);
    }
    return candidate;
}

/**
 * Reads the prepared manifest and returns every byte that the worker validates.
 * The guest protocol uses the raw manifest-file hash, so this list deliberately
 * carries that exact file before the fixture PDFs.
 */
export async function resolveWindowsTestFixtureInputs(manifestPath: string): Promise<IWindowsTestStagedInput[]> {
    const manifest = await loadFixtureManifest(manifestPath);
    const manifestBytes = await readFile(manifestPath);
    const inputs: IWindowsTestStagedInput[] = [{
        hostPath: manifestPath,
        guestRelativePath: 'fixtures/manifest.json',
        sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    }];
    const guestNames = new Set(['fixtures/manifest.json']);
    for (const pack of manifest.packs) {
        for (const file of pack.files) {
            if (file.sha256 === null) {
                throw new Error(`Prepared fixture ${file.id} has no sha256; planned fixtures cannot enter a run.`);
            }
            const hostPath = resolveFixtureCachePath(manifestPath, file.path);
            const bytes = await readFile(hostPath).catch((error: unknown) => {
                throw new Error(`Prepared fixture ${file.id} at ${hostPath} could not be read: ${String(error)}.`);
            });
            if (bytes.byteLength !== file.bytes) {
                throw new Error(`Prepared fixture ${file.id} is ${bytes.byteLength} bytes, expected ${file.bytes}.`);
            }
            const actualSha256 = createHash('sha256').update(bytes).digest('hex');
            if (actualSha256 !== file.sha256) {
                throw new Error(`Prepared fixture ${file.id} hashes to ${actualSha256}, expected ${file.sha256}.`);
            }
            const guestRelativePath = `fixtures/${fixtureFileName(file.path)}`;
            if (guestNames.has(guestRelativePath)) {
                throw new Error(`Prepared fixtures contain duplicate staged file name ${guestRelativePath}.`);
            }
            guestNames.add(guestRelativePath);
            inputs.push({
                hostPath,
                guestRelativePath,
                sha256: file.sha256,
            });
        }
    }
    return inputs;
}

export function defaultRepositoryRoot() {
    return path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
}

function infrastructureReport(message: string): IWindowsTestRunReport {
    return {
        exitCode: windowsTestExitCodes.infrastructureFailed,
        outcome: 'infrastructure-failed',
        runId: null,
        activeRunId: null,
        summary: null,
        messages: [message],
    };
}

// `--artifact` names the file; the version, source revision and architecture
// come from the recorded candidate or from a sidecar metadata file written by
// the build that produced the installer.
export async function resolveWindowsTestCandidate(
    config: IWindowsTestHostConfig,
    artifactPath: string | null,
): Promise<IWindowsTestCandidate | null> {
    if (artifactPath === null) {
        return config.candidate;
    }
    const bytes = await readFile(artifactPath).catch(() => null);
    if (bytes === null) {
        throw new Error(`The candidate artifact ${artifactPath} could not be read.`);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (config.candidate !== null && path.resolve(config.candidate.artifactPath) === path.resolve(artifactPath)) {
        if (config.candidate.sha256 !== sha256) {
            throw new Error(
                `The configured candidate ${artifactPath} hashes to ${sha256}, but config.json records ${config.candidate.sha256}; re-register the build before running it.`,
            );
        }
        return config.candidate;
    }
    const metadataPath = `${artifactPath}${WINDOWS_TEST_CANDIDATE_METADATA_SUFFIX}`;
    const metadataText = await readFile(metadataPath, 'utf8').catch(() => null);
    if (metadataText === null) {
        throw new Error([
            `The artifact ${artifactPath} has no recorded build identity.`,
            `Write ${metadataPath} with {"version", "sourceSha", "appArch"} or record the candidate in the host configuration.`,
        ].join(' '));
    }
    const metadata: unknown = JSON.parse(metadataText);
    if (!isRecord(metadata)
        || typeof metadata.version !== 'string'
        || typeof metadata.sourceSha !== 'string'
        || !isOneOf(windowsTestArchitectures, metadata.appArch)) {
        throw new Error(`${metadataPath} must record a string version, a string sourceSha and an appArch of arm64 or x64.`);
    }
    return {
        artifactPath,
        sha256,
        fileName: path.basename(artifactPath),
        version: metadata.version,
        sourceSha: metadata.sourceSha,
        appArch: metadata.appArch,
    };
}

export interface IWindowsTestRunIdentity {
    runnerVersion: string;
    appVersion: string;
    sourceSha: string;
    artifactFileName: string;
    artifactSha256: string;
    imageId: string;
    environment: string;
}

export interface IWindowsTestHostRunOptions {
    suite: TWindowsTestSuite;
    tests: string[] | null;
    environment: string | null;
    artifact: string | null;
    dataRoot: string | null;
    env: NodeJS.ProcessEnv;
    repositoryRoot?: string;
    onIdentity?(identity: IWindowsTestRunIdentity): void;
}

export async function executeWindowsTestRunOnHost(
    options: IWindowsTestHostRunOptions,
): Promise<IWindowsTestRunReport> {
    const layout = windowsTestHostLayout(options.dataRoot ?? resolveWindowsTestDataRoot(options.env));
    let config: IWindowsTestHostConfig;
    try {
        config = await loadWindowsTestHostConfig(layout.configFile);
    } catch (error) {
        if (error instanceof WindowsTestConfigError && error.kind === 'config-missing') {
            return infrastructureReport(describeMissingWindowsTestConfig(layout.configFile));
        }
        return infrastructureReport(error instanceof Error ? error.message : String(error));
    }

    let candidate: IWindowsTestCandidate | null;
    try {
        candidate = await resolveWindowsTestCandidate(config, options.artifact);
    } catch (error) {
        return infrastructureReport(error instanceof Error ? error.message : String(error));
    }

    const manifestPath = path.join(layout.baselinesDir, `${config.goldenImageId}.json`);
    const imageManifest = await loadWindowsTestImageManifest(manifestPath).catch(() => null);
    if (imageManifest === null) {
        return infrastructureReport(`The golden image manifest ${manifestPath} is missing or malformed; qualify the image before running the lane.`);
    }
    let stagedInputs: IWindowsTestStagedInput[];
    try {
        stagedInputs = await resolveWindowsTestFixtureInputs(
            path.join(layout.fixturesCacheDir, WINDOWS_TEST_FIXTURE_MANIFEST_FILE_NAME),
        );
    } catch (error) {
        return infrastructureReport(error instanceof Error ? error.message : String(error));
    }

    options.onIdentity?.({
        runnerVersion: WINDOWS_TEST_RUNNER_VERSION,
        appVersion: candidate?.version ?? 'unknown',
        sourceSha: candidate?.sourceSha ?? 'unknown',
        artifactFileName: candidate?.fileName ?? 'unknown',
        artifactSha256: candidate?.sha256 ?? 'unknown',
        imageId: imageManifest.imageId,
        environment: options.environment ?? config.environment,
    });

    const runner = createProcessCommandRunner();
    const utmctl = createUtmctlClient({
        runner,
        dataRoot: layout.root,
        env: options.env,
    });
    const guest = createUtmctlGuestChannel({
        client: utmctl,
        temporaryFilePath: label => path.join(tmpdir(), `evb-windows-test-${label}-${randomBytes(8).toString('hex')}`),
    });
    const clock = createSystemClock();
    const probe = createProcessIdentityProbe(runner);
    const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot();

    return executeWindowsTestRun(
        {
            suite: options.suite,
            environment: options.environment ?? config.environment,
            tests: options.tests,
        },
        {
            config: {
                ...config,
                candidate,
            },
            layout,
            utmctl,
            guest,
            clock,
            suiteResolver: createCapabilityFileSuiteResolver(
                path.join(repositoryRoot, WINDOWS_TEST_CAPABILITY_REGISTRY_RELATIVE_PATH),
            ),
            fixtureManifest: createFileFixtureManifestSource(
                path.join(layout.fixturesCacheDir, WINDOWS_TEST_FIXTURE_MANIFEST_FILE_NAME),
            ),
            imageManifest,
            stagedInputs,
            evaluateHostOracles: input => runWindowsHostOracles({
                ...input,
                repositoryRoot,
            }),
            cloneVm: async cloneName => {
                await createTestClone({
                    config,
                    manifest: imageManifest,
                    cloneName,
                    runner,
                    utmctl,
                });
            },
            lock: {
                hostId: hostname(),
                pid: process.pid,
                probe,
                nowIso: () => clock.nowIso(),
                sleep: milliseconds => clock.sleep(milliseconds),
            },
            probe,
            hostId: hostname(),
            randomRunSuffix: () => randomBytes(6).toString('hex'),
        },
    );
}

export interface IWindowsTestDoctorHostOptions {
    dataRoot: string | null;
    env: NodeJS.ProcessEnv;
    launcherPath: string;
}

export async function runWindowsTestDoctorOnHost(
    options: IWindowsTestDoctorHostOptions,
): Promise<IWindowsTestDoctorReport> {
    const layout = windowsTestHostLayout(options.dataRoot ?? resolveWindowsTestDataRoot(options.env));
    const runner = createProcessCommandRunner();
    return runWindowsTestDoctor({
        layout,
        utmctl: createUtmctlClient({
            runner,
            dataRoot: layout.root,
            env: options.env,
        }),
        sessionProbe: createLaunchctlSessionProbe(runner),
        env: options.env,
        launcherPath: options.launcherPath,
        hashFile: async filePath => createHash('sha256').update(await readFile(filePath)).digest('hex'),
    });
}

export interface IWindowsTestStopHostOptions {
    runId: string;
    reason: string;
    dataRoot: string | null;
    env: NodeJS.ProcessEnv;
}

export async function requestWindowsTestStopOnHost(
    options: IWindowsTestStopHostOptions,
): Promise<IWindowsTestStopResult> {
    const layout = windowsTestHostLayout(options.dataRoot ?? resolveWindowsTestDataRoot(options.env));
    let config: IWindowsTestHostConfig;
    try {
        config = await loadWindowsTestHostConfig(layout.configFile);
    } catch (error) {
        return {
            exitCode: windowsTestExitCodes.infrastructureFailed,
            messages: [error instanceof WindowsTestConfigError && error.kind === 'config-missing'
                ? describeMissingWindowsTestConfig(layout.configFile)
                : (error instanceof Error ? error.message : String(error))],
            recovered: false,
        };
    }
    const runner = createProcessCommandRunner();
    const clock = createSystemClock();
    const probe = createProcessIdentityProbe(runner);
    return requestWindowsTestStop(
        {
            runId: options.runId,
            reason: options.reason,
        },
        {
            layout,
            config,
            utmctl: createUtmctlClient({
                runner,
                dataRoot: layout.root,
                env: options.env,
            }),
            probe,
            lock: {
                hostId: hostname(),
                pid: process.pid,
                probe,
                nowIso: () => clock.nowIso(),
                sleep: milliseconds => clock.sleep(milliseconds),
            },
            nowIso: () => clock.nowIso(),
        },
    );
}
