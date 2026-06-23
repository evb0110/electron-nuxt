import {
    describe,
    expect,
    it,
} from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

type TReleaseArch = 'arm64' | 'x64';
type TReleasePlatform = 'linux' | 'mac' | 'win';
type TReleaseEnv = Record<string, string>;
type TRunCommand = (
    command: string,
    args: string[],
    options: IRunCommandOptions,
) => unknown;
type TGeneratedResourceRunCommand = (
    command: string,
    args: string[],
    options: { env: TReleaseEnv },
) => unknown;
type TSleepFn = (duration: number) => Promise<void>;

interface IReleaseTarget {
    arch: string;
    expectsUpdaterMetadata?: boolean;
    isPrimaryHostTarget?: boolean;
    platform: string;
}

interface IReleaseCommand {
    args: string[];
    command: string;
}

interface IRunCommandOptions {
    env?: TReleaseEnv;
    stdio?: 'inherit';
}

interface IReleasePolicyModule {
    assertPublishUpdaterMetadataReferences: (
        artifactNames: string[],
        readMetadataText: (fileName: string) => string,
    ) => boolean;
    assertPublishUpdaterMetadataPolicy: (
        artifactNames: string[],
        env?: TReleaseEnv,
    ) => void;
    detectHostReleasePlatform: (nodePlatform?: string) => TReleasePlatform;
    expectsUpdaterMetadata: (
        target: IReleaseTarget,
        env?: TReleaseEnv,
    ) => boolean;
    getLocalReleaseTargets: (options?: {
        arch?: TReleaseArch;
        platform?: NodeJS.Platform;
    }) => IReleaseTarget[];
    getReleaseAutomationEnv: (
        baseEnv?: TReleaseEnv,
    ) => TReleaseEnv;
    getRequiredArtifactPatterns: (
        target: IReleaseTarget,
        env?: TReleaseEnv,
    ) => RegExp[];
    parseUpdaterMetadataFileUrls: (
        metadataFileName: string,
        metadataText: string,
    ) => string[];
    shouldVerifyPackagedStartup: (
        target: IReleaseTarget,
        env?: TReleaseEnv,
    ) => boolean;
}

interface IReleaseChecksModule {
    getLocalReleaseCheckCommands: () => IReleaseCommand[];
    runLocalReleaseChecks: (options?: {
        env?: TReleaseEnv;
        runCommand?: TRunCommand;
    }) => void;
}

interface IReleaseVerifySnapshot {
    stagedDiff: string;
    trackedDiff: string;
    untrackedFiles: string[];
}

interface IReleaseVerifyModule {
    assertReleaseVerifyDidNotMutateWorktree: (
        before: IReleaseVerifySnapshot,
        after: IReleaseVerifySnapshot,
    ) => void;
    getLocalReleaseVerifyCommands: () => IReleaseCommand[];
    runLocalReleaseVerify: (options?: {
        runCommand?: TRunCommand;
        snapshotGetter?: () => IReleaseVerifySnapshot;
    }) => void;
}

interface IReleasePackageModule {
    getGeneratedNativeResourceCommands: (target: IReleaseTarget) => IReleaseCommand[];
    getLocalReleaseBuildCommand: () => IReleaseCommand;
    getPackagingArgs: (
        target: IReleaseTarget,
        env?: TReleaseEnv,
    ) => string[];
    prepareGeneratedNativeResources: (
        target: IReleaseTarget,
        env: TReleaseEnv,
        runCommand?: TGeneratedResourceRunCommand,
    ) => void;
}

interface IAssertBuildArtifactsOptions {
    arch: TReleaseArch;
    artifactNames: string[];
    env?: TReleaseEnv;
    platform: TReleasePlatform;
    readMetadataText: (fileName: string) => string;
}

interface IAssertBuildArtifactsModule { assertBuildArtifacts: (options: IAssertBuildArtifactsOptions) => boolean; }

interface IReleaseSharedModule {
    assertGitHubCliReady: (
        workflowName: string,
        options: {
            delayMs: number;
            runCommand: TRunCommand;
            sleepFn: TSleepFn;
            stderr: { write: (message: string) => void };
        },
    ) => Promise<void>;
    assertTagAbsent: (
        tag: string,
        remote: string,
        options: {
            delayMs: number;
            runCommand: TRunCommand;
            sleepFn: TSleepFn;
            stderr: { write: (message: string) => void };
        },
    ) => Promise<void>;
    filterIgnoredFiles: (files: string[], ignoredRoots: string[]) => string[];
    isTransientGitHubAuthError: (error: unknown) => boolean;
    isTransientRemoteGitError: (error: unknown) => boolean;
}

const {
    detectHostReleasePlatform,
    assertPublishUpdaterMetadataReferences,
    assertPublishUpdaterMetadataPolicy,
    expectsUpdaterMetadata,
    getLocalReleaseTargets,
    getReleaseAutomationEnv,
    getRequiredArtifactPatterns,
    parseUpdaterMetadataFileUrls,
    shouldVerifyPackagedStartup,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/policy.mjs')).href) as IReleasePolicyModule;
const {
    getLocalReleaseCheckCommands,
    runLocalReleaseChecks,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/verify-local-checks.mjs')).href) as IReleaseChecksModule;
const {
    assertReleaseVerifyDidNotMutateWorktree,
    getLocalReleaseVerifyCommands,
    runLocalReleaseVerify,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/verify-local.mjs')).href) as IReleaseVerifyModule;
const {
    getGeneratedNativeResourceCommands,
    getLocalReleaseBuildCommand,
    getPackagingArgs,
    prepareGeneratedNativeResources,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/verify-local-package.mjs')).href) as IReleasePackageModule;
const { assertBuildArtifacts } = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/assert-build-artifacts.mjs')).href) as IAssertBuildArtifactsModule;
const {
    assertGitHubCliReady,
    assertTagAbsent,
    filterIgnoredFiles,
    isTransientGitHubAuthError,
    isTransientRemoteGitError,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/shared.mjs')).href) as IReleaseSharedModule;

describe('release policy', () => {
    it('derives local release targets from host platform and arch', () => {
        expect(getLocalReleaseTargets({
            arch: 'arm64',
            platform: 'darwin',
        })).toEqual([{
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'mac',
        }]);

        expect(getLocalReleaseTargets({
            arch: 'x64',
            platform: 'win32',
        })).toEqual([{
            arch: 'x64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'win',
        }]);
    });

    it('keeps updater metadata and startup verification aligned with signing state', () => {
        const macTarget = {
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'mac',
        };
        const unsignedEnv = {};
        const signedEnv = {
            CSC_KEY_PASSWORD: 'secret',
            CSC_LINK: 'base64://cert',
        };

        expect(expectsUpdaterMetadata(macTarget, unsignedEnv)).toBe(false);
        expect(expectsUpdaterMetadata(macTarget, signedEnv)).toBe(true);
        expect(expectsUpdaterMetadata(macTarget, { EVB_RELEASE_HAS_MAC_SIGNING: 'true' })).toBe(true);
        expect(shouldVerifyPackagedStartup(macTarget, unsignedEnv)).toBe(false);
        expect(shouldVerifyPackagedStartup(macTarget, signedEnv)).toBe(true);
    });

    it('provides a release automation env that stays in CI mode', () => {
        expect(getReleaseAutomationEnv({ FOO: 'bar' })).toEqual({
            CI: 'true',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            FOO: 'bar',
        });
    });

    it('reports supported host platforms and required packaged artifacts', () => {
        expect(detectHostReleasePlatform('darwin')).toBe('mac');
        expect(detectHostReleasePlatform('linux')).toBe('linux');
        expect(detectHostReleasePlatform('win32')).toBe('win');
        expect(() => detectHostReleasePlatform('freebsd')).toThrow(
            'Unsupported local release platform "freebsd"',
        );

        expect(getRequiredArtifactPatterns({
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            platform: 'mac',
        }, {
            CSC_KEY_PASSWORD: 'password',
            CSC_LINK: 'certificate',
        }).map((pattern: RegExp) => pattern.source)).toEqual([
            '\\.dmg$',
            '\\.zip$',
        ]);

        expect(getRequiredArtifactPatterns({
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            platform: 'mac',
        }, { EVB_RELEASE_HAS_MAC_SIGNING: 'true' }).map((pattern: RegExp) => pattern.source)).toEqual([
            '\\.dmg$',
            '\\.zip$',
        ]);

        expect(getRequiredArtifactPatterns({
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            platform: 'mac',
        }, {}).map((pattern: RegExp) => pattern.source)).toEqual([ '\\.dmg$' ]);
    });

    it('rejects publish-time updater metadata that does not match signing policy', () => {
        expect(() => assertPublishUpdaterMetadataPolicy([
            'EVB Viewer-0.1.0-arm64.dmg',
            'latest-mac.yml',
            'EVB Viewer-0.1.0-arm64.dmg.blockmap',
        ], {
            EVB_RELEASE_HAS_MAC_SIGNING: 'false',
            EVB_RELEASE_HAS_WINDOWS_SIGNING: 'false',
        })).toThrow('latest-mac.yml');

        expect(() => assertPublishUpdaterMetadataPolicy([
            'EVB Viewer Setup 0.1.0.exe',
            'latest.yml',
            'EVB Viewer Setup 0.1.0.exe.blockmap',
        ], {
            EVB_RELEASE_HAS_MAC_SIGNING: 'false',
            EVB_RELEASE_HAS_WINDOWS_SIGNING: 'false',
        })).toThrow('latest.yml');

        expect(() => assertPublishUpdaterMetadataPolicy([
            'EVB Viewer-0.1.0.AppImage',
            'latest-linux.yml',
        ], {
            EVB_RELEASE_HAS_MAC_SIGNING: 'false',
            EVB_RELEASE_HAS_WINDOWS_SIGNING: 'true',
        })).toThrow('latest-linux.yml');

        expect(() => assertPublishUpdaterMetadataPolicy([
            'EVB Viewer-0.1.0-arm64.dmg',
            'latest-mac.yml',
            'EVB Viewer-0.1.0-arm64.dmg.blockmap',
            'EVB Viewer Setup 0.1.0.exe',
            'latest.yml',
            'EVB Viewer Setup 0.1.0.exe.blockmap',
        ], {
            EVB_RELEASE_HAS_MAC_SIGNING: 'true',
            EVB_RELEASE_HAS_WINDOWS_SIGNING: 'true',
        })).not.toThrow();
    });

    it('validates publish-time updater metadata asset references without shell parsing', () => {
        const metadata = new Map([
            [
                'latest-mac.yml',
                [
                    'version: 0.1.0',
                    'path: "EVB Viewer-0.1.0-arm64.dmg"',
                    'sha512: abc',
                ].join('\n'),
            ],
            [
                'latest.yml',
                [
                    'version: 0.1.0',
                    'path: \'EVB Viewer Setup 0.1.0.exe\'',
                    'sha512: def',
                ].join('\n'),
            ],
        ]);

        expect(assertPublishUpdaterMetadataReferences([
            'EVB Viewer-0.1.0-arm64.dmg',
            'EVB Viewer Setup 0.1.0.exe',
            'latest-mac.yml',
            'latest.yml',
        ], (fileName: string) => metadata.get(fileName) ?? '')).toBe(true);
    });

    it('rejects publish-time updater metadata that points at missing or unsafe assets', () => {
        expect(() => assertPublishUpdaterMetadataReferences([ 'latest-mac.yml' ], () => 'path: "Missing.dmg"\n'))
            .toThrow('Missing.dmg not found');

        expect(() => assertPublishUpdaterMetadataReferences([ 'latest.yml' ], () => 'path: "../EVB Viewer Setup 0.1.0.exe"\n'))
            .toThrow('Unsafe path entry');
    });

    describe('updater metadata file url validation', () => {
        const metadataText = [
            'version: 0.1.0',
            'files:',
            '  - url: EVB-Viewer-0.1.0-arm64.zip',
            '    sha512: abc',
            '  - url: EVB-Viewer-0.1.0-arm64.dmg',
            '    sha512: def',
            'path: EVB-Viewer-0.1.0-arm64.zip',
        ].join('\n');

        it('parses every files[].url entry', () => {
            expect(parseUpdaterMetadataFileUrls('latest-mac.yml', metadataText)).toEqual([
                'EVB-Viewer-0.1.0-arm64.zip',
                'EVB-Viewer-0.1.0-arm64.dmg',
            ]);
        });

        it('rejects metadata whose files[].url is not among the artifacts', () => {
            const artifacts = [
                'latest-mac.yml',
                'EVB-Viewer-0.1.0-arm64.zip',
            ];
            expect(() => assertPublishUpdaterMetadataReferences(
                artifacts,
                () => metadataText,
            )).toThrow(/EVB-Viewer-0\.1\.0-arm64\.dmg not found/u);
        });

        it('accepts metadata whose path and files[].url all exist', () => {
            const artifacts = [
                'latest-mac.yml',
                'EVB-Viewer-0.1.0-arm64.zip',
                'EVB-Viewer-0.1.0-arm64.dmg',
            ];
            expect(assertPublishUpdaterMetadataReferences(
                artifacts,
                () => metadataText,
            )).toBe(true);
        });

        it('rejects unsafe url entries', () => {
            expect(() => parseUpdaterMetadataFileUrls('latest-mac.yml', 'files:\n  - url: ../evil.zip\n')).toThrow(/Unsafe path entry/u);
        });
    });

    it('keeps release checks focused on static checks and release-critical tests', () => {
        const commandArgs: string[][] = getLocalReleaseCheckCommands()
            .map((command: { args: string[] }) => command.args);
        const scriptNames = commandArgs
            .filter(args => args[0] === 'run')
            .map(args => args[1]);

        expect(commandArgs).toEqual([
            [
                'run',
                'lint',
            ],
            [
                '--dir',
                'landing',
                'run',
                'check:vendor',
            ],
            [
                'run',
                'typecheck',
            ],
            [
                'run',
                'check:electron:install',
            ],
            [
                'run',
                'check:resources:matrix',
            ],
            [
                'run',
                'check:wasm:portable',
            ],
            [
                'run',
                'check:architecture:all',
            ],
            [
                'run',
                'test:rust',
            ],
            [
                'run',
                'test:release',
            ],
            [
                'run',
                'test:bundle-integrity',
            ],
        ]);
        expect(scriptNames).not.toContain('validate');
        expect(scriptNames).not.toContain('build:strict');
        expect(scriptNames).not.toContain('test:python-page-processor');
    });

    it('keeps standalone release verification composed from focused local gates', () => {
        expect(getLocalReleaseVerifyCommands().map((command: { args: string[] }) => command.args)).toEqual([
            [
                'run',
                'release:verify:checks',
            ],
            [
                'run',
                'release:verify:package:local',
            ],
        ]);
    });

    it('can ignore landing-only worktree changes for main app releases', () => {
        expect(filterIgnoredFiles([
            'package.json',
            'landing/vendor/contracts/index.ts',
            'landing/package.json',
            'app/app.vue',
        ], [ 'landing' ])).toEqual([
            'package.json',
            'app/app.vue',
        ]);
    });

    it('retries transient remote tag lookup failures during release preflight', async () => {
        const stderr: string[] = [];
        const sleeps: number[] = [];
        let remoteAttempts = 0;

        await assertTagAbsent('v1.2.3', 'origin', {
            delayMs: 10,
            runCommand: (_command: string, args: string[]) => {
                if (args[0] === 'rev-parse') {
                    throw Object.assign(new Error('unknown revision'), { status: 128 });
                }

                remoteAttempts += 1;
                if (remoteAttempts === 1) {
                    throw Object.assign(new Error('Recv failure: Connection reset by peer'), { status: 128 });
                }

                throw Object.assign(new Error('not found'), { status: 2 });
            },
            sleepFn: async (duration: number) => {
                sleeps.push(duration);
            },
            stderr: { write: (message: string) => stderr.push(message) },
        });

        expect(remoteAttempts).toBe(2);
        expect(sleeps).toEqual([10]);
        expect(stderr.join('')).toContain('Transient remote tag check failure for v1.2.3');
        expect(isTransientRemoteGitError(new Error('Recv failure: Connection reset by peer'))).toBe(true);
    });

    it('retries transient GitHub CLI auth keyring failures during release preflight', async () => {
        const stderr: string[] = [];
        const sleeps: number[] = [];
        let attempts = 0;

        await assertGitHubCliReady('Release', {
            delayMs: 10,
            runCommand: () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error('Timeout trying to log in to github.com account evb0110 (keyring)');
                }
                return '';
            },
            sleepFn: async (duration: number) => {
                sleeps.push(duration);
            },
            stderr: { write: (message: string) => stderr.push(message) },
        });

        expect(attempts).toBe(2);
        expect(sleeps).toEqual([10]);
        expect(stderr.join('')).toContain('Transient GitHub CLI auth check failure');
        expect(isTransientGitHubAuthError(new Error('Timeout trying to log in to github.com account evb0110 (keyring)'))).toBe(true);
    });

    it('runs release checks under the supplied CI-mode environment', () => {
        const calls: Array<{
            args: string[];
            command: string;
            env?: Record<string, string>;
        }> = [];

        runLocalReleaseChecks({
            env: {
                CI: 'true',
                FOO: 'bar',
            },
            runCommand: (command: string, args: string[], options: { env?: Record<string, string> }) => {
                calls.push({
                    args,
                    command,
                    ...(options.env === undefined ? {} : { env: options.env }),
                });
            },
        });

        expect(calls).toHaveLength(getLocalReleaseCheckCommands().length);
        expect(calls.every(call => call.command === 'pnpm')).toBe(true);
        expect(calls.every(call => call.env?.CI === 'true')).toBe(true);
        expect(calls.every(call => call.env?.FOO === 'bar')).toBe(true);
    });

    it('defaults release checks to the shared CI-mode environment', () => {
        const calls: Array<{
            args: string[];
            command: string;
            env?: Record<string, string>;
        }> = [];
        const runCommand = (command: string, args: string[], options: { env?: Record<string, string> }) => {
            calls.push({
                args,
                command,
                ...(options.env === undefined ? {} : { env: options.env }),
            });
        };

        runLocalReleaseChecks({ runCommand });

        expect(calls).toHaveLength(getLocalReleaseCheckCommands().length);
        expect(calls.every(call => call.command === 'pnpm')).toBe(true);
        expect(calls.every(call => call.env?.CI === 'true')).toBe(true);
        expect(calls.every(call => call.env?.EVB_AUTOMATION_HIDE_WINDOW === undefined)).toBe(true);
        expect(calls.every(call => call.env?.EVB_AUTOMATION_NO_FOCUS === undefined)).toBe(true);
    });

    it('fails standalone release verification when the worktree snapshot changes', () => {
        expect(() => assertReleaseVerifyDidNotMutateWorktree({
            stagedDiff: '',
            trackedDiff: '',
            untrackedFiles: [],
        }, {
            stagedDiff: '',
            trackedDiff: 'diff --git a/package.json b/package.json',
            untrackedFiles: [],
        })).toThrow('tracked diff');
    });

    it('checks standalone release verification mutations after successful commands', () => {
        const calls: Array<{
            args: string[];
            command: string;
        }> = [];
        let snapshotCount = 0;

        expect(() => runLocalReleaseVerify({
            runCommand: (command: string, args: string[]) => {
                calls.push({
                    args,
                    command,
                });
                return '';
            },
            snapshotGetter: () => {
                snapshotCount += 1;
                return {
                    stagedDiff: '',
                    trackedDiff: snapshotCount === 1 ? '' : 'changed',
                    untrackedFiles: [],
                };
            },
        })).toThrow('tracked diff');

        expect(calls.map(call => call.args)).toEqual([
            [
                'run',
                'release:verify:checks',
            ],
            [
                'run',
                'release:verify:package:local',
            ],
        ]);
    });

    it('keeps build-warning enforcement in the local packaging phase', () => {
        expect(getLocalReleaseBuildCommand()).toEqual({
            args: [
                'run',
                'build:strict',
            ],
            command: 'pnpm',
        });
    });

    it('does not generate optional page-processor resources during local release packaging', () => {
        for (const target of [
            {
                arch: 'arm64',
                platform: 'mac',
            },
            {
                arch: 'x64',
                platform: 'linux',
            },
            {
                arch: 'x64',
                platform: 'win',
            },
        ]) {
            expect(getGeneratedNativeResourceCommands(target)).toEqual([]);
        }
    });

    it('leaves page-processor copying disabled during local packaging by default', () => {
        for (const target of [
            {
                arch: 'arm64',
                platform: 'mac',
            },
            {
                arch: 'x64',
                platform: 'linux',
            },
            {
                arch: 'x64',
                platform: 'win',
            },
        ]) {
            const env: Record<string, string> = {};
            const calls: Array<{
                args: string[];
                command: string;
                env: Record<string, string>;
            }> = [];

            prepareGeneratedNativeResources(target, env, (
                command: string,
                args: string[],
                options: { env: Record<string, string> },
            ) => {
                calls.push({
                    args,
                    command,
                    env: options.env,
                });
            });

            expect(env.EVB_INCLUDE_PAGE_PROCESSOR).toBeUndefined();
            expect(calls).toEqual([]);
        }
    });

    it('uses a ZIP-only local package check for supplemental macOS Intel builds', () => {
        expect(getPackagingArgs({
            arch: 'x64',
            platform: 'mac',
        })).toEqual([
            'exec',
            'electron-builder',
            '--publish',
            'never',
            '--mac',
            'zip',
            '--x64',
        ]);
    });

    it('uses a DMG-only local package check for unsigned macOS arm64 builds', () => {
        expect(getPackagingArgs({
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            platform: 'mac',
        }, {})).toEqual([
            'exec',
            'electron-builder',
            '--publish',
            'never',
            '--mac',
            'dmg',
            '--arm64',
        ]);
    });

    it('keeps ZIP generation for signed macOS arm64 builds with updater metadata', () => {
        expect(getPackagingArgs({
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            platform: 'mac',
        }, {
            CSC_KEY_PASSWORD: 'password',
            CSC_LINK: 'certificate',
        })).toEqual([
            'exec',
            'electron-builder',
            '--publish',
            'never',
            '--mac',
            '--arm64',
        ]);
    });

    it('validates matrix build artifacts before upload', () => {
        const macMetadata = [
            'version: 0.1.0',
            'path: EVB-Viewer-0.1.0-arm64.zip',
            'files:',
            '  - url: EVB-Viewer-0.1.0-arm64.zip',
            '  - url: EVB-Viewer-0.1.0-arm64.dmg',
        ].join('\n');

        expect(assertBuildArtifacts({
            arch: 'arm64',
            platform: 'mac',
            env: {
                EVB_RELEASE_HAS_MAC_SIGNING: 'true',
                EVB_RELEASE_HAS_WINDOWS_SIGNING: 'false',
            },
            artifactNames: [
                'EVB-Viewer-0.1.0-arm64.dmg',
                'EVB-Viewer-0.1.0-arm64.dmg.blockmap',
                'EVB-Viewer-0.1.0-arm64.zip',
                'EVB-Viewer-0.1.0-arm64.zip.blockmap',
                'latest-mac.yml',
            ],
            readMetadataText: () => macMetadata,
        })).toBe(true);

        expect(() => assertBuildArtifacts({
            arch: 'arm64',
            platform: 'linux',
            artifactNames: [
                'EVB Viewer-0.1.0-arm64.AppImage',
                'EVB Viewer-0.1.0-arm64.deb',
                'latest-linux.yml',
            ],
            readMetadataText: () => 'path: EVB Viewer-0.1.0-arm64.AppImage\n',
        })).toThrow('latest-linux.yml');

        expect(() => assertBuildArtifacts({
            arch: 'arm64',
            platform: 'win',
            env: {
                EVB_RELEASE_HAS_MAC_SIGNING: 'false',
                EVB_RELEASE_HAS_WINDOWS_SIGNING: 'true',
            },
            artifactNames: [
                'EVB Viewer Setup 0.1.0-arm64.exe',
                'EVB Viewer Setup 0.1.0-arm64.exe.blockmap',
            ],
            readMetadataText: () => '',
        })).toThrow('Unexpected updater metadata for win-arm64');
    });
});
