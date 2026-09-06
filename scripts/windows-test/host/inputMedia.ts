import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    constants,
    lstat,
    mkdir,
    mkdtemp,
    realpath,
    rm,
    stat,
    copyFile,
    writeFile,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isSha256Hex } from '@scripts/windows-test/contracts/windowsTestContracts';
import type { ICommandRunner } from '@scripts/windows-test/host/utmctlClient';

export const WINDOWS_TEST_INPUT_MEDIA_VOLUME_NAME = 'EVB_INPUTS';
export const WINDOWS_TEST_INPUT_MEDIA_MARKER_FILE = 'EVB_INPUTS.MARKER';

const DEFAULT_HDIUTIL_PATH = '/usr/bin/hdiutil';
const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60 * 1_000;

export interface IWindowsTestInputMediaSource {
    hostPath: string;
    sha256: string;
}

export interface IWindowsTestInputMedia {
    isoPath: string;
    volumeName: typeof WINDOWS_TEST_INPUT_MEDIA_VOLUME_NAME;
    markerFileName: typeof WINDOWS_TEST_INPUT_MEDIA_MARKER_FILE;
    markerSha256: string;
    hostPathToMediaFile: ReadonlyMap<string, string>;
}

export interface IWindowsTestInputMediaFileSystem {
    lstat(filePath: string): Promise<Stats>;
    stat(filePath: string): Promise<Stats>;
    realpath(filePath: string): Promise<string>;
    mkdir(directoryPath: string, options: {recursive: boolean}): Promise<void>;
    mkdtemp(prefix: string): Promise<string>;
    copyFile(sourcePath: string, destinationPath: string, mode: number): Promise<void>;
    writeFile(filePath: string, contents: string, encoding: 'utf8'): Promise<void>;
    rm(filePath: string, options: {
        force: boolean;
        recursive?: boolean;
    }): Promise<void>;
}

const defaultFileSystem: IWindowsTestInputMediaFileSystem = {
    lstat,
    stat,
    realpath,
    mkdir: async (directoryPath, options) => {
        await mkdir(directoryPath, options);
    },
    mkdtemp,
    copyFile,
    writeFile,
    rm,
};

export interface IWindowsTestInputMediaBuildOptions {
    outputPath: string;
    sources: readonly IWindowsTestInputMediaSource[];
    runner: ICommandRunner;
    hdiutilPath?: string;
    timeoutMs?: number;
    temporaryDirectory?: string;
    fileSystem?: IWindowsTestInputMediaFileSystem;
    hashFile?: (filePath: string) => Promise<string>;
}

function mediaFileName(sha256: string) {
    // Joliet allows 64 characters. A prefix or extension makes hdiutil
    // silently truncate the digest, so use the complete hash alone.
    return sha256;
}

async function defaultHashFile(filePath: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

async function pathIsPresent(fileSystem: IWindowsTestInputMediaFileSystem, filePath: string) {
    try {
        await fileSystem.lstat(filePath);
        return true;
    } catch {
        return false;
    }
}

function markerContents(fileNames: readonly string[]) {
    return `${JSON.stringify({
        format: 'evb-windows-test-input-media-v1',
        volumeName: WINDOWS_TEST_INPUT_MEDIA_VOLUME_NAME,
        files: [...fileNames].sort(),
    }, null, 4)}\n`;
}

function normalizedHostPath(hostPath: string) {
    return path.resolve(hostPath);
}

/**
 * Builds the read-only input disk used by the UTM clone. Every source is
 * checked against its expected digest before it enters the image, and the
 * image contains only digest-derived names plus a small identity marker.
 */
export async function buildWindowsTestInputMedia(
    options: IWindowsTestInputMediaBuildOptions,
): Promise<IWindowsTestInputMedia> {
    if (options.sources.length === 0) {
        throw new Error('The Windows test input media must contain at least one source file.');
    }
    const fileSystem = options.fileSystem ?? defaultFileSystem;
    const hashFile = options.hashFile ?? defaultHashFile;
    const outputPath = path.resolve(options.outputPath);
    if (await pathIsPresent(fileSystem, outputPath)) {
        throw new Error(`The Windows test input media output already exists at ${outputPath}.`);
    }
    await fileSystem.mkdir(path.dirname(outputPath), {recursive: true});

    const temporaryParent = path.resolve(options.temporaryDirectory ?? tmpdir());
    await fileSystem.mkdir(temporaryParent, {recursive: true});
    const stagingDirectory = await fileSystem.mkdtemp(path.join(temporaryParent, 'evb-windows-input-media-'));
    const hostPathToMediaFile = new Map<string, string>();
    const realPathToMediaFile = new Map<string, string>();
    const mediaFileNames = new Set<string>();
    let outputWasCreated = false;
    try {
        for (const source of options.sources) {
            if (!isSha256Hex(source.sha256)) {
                throw new Error(`The expected SHA-256 for ${source.hostPath} is invalid.`);
            }
            const hostPath = normalizedHostPath(source.hostPath);
            if (hostPathToMediaFile.has(hostPath)) {
                const existing = hostPathToMediaFile.get(hostPath);
                const expected = mediaFileName(source.sha256.toLowerCase());
                if (existing !== expected) {
                    throw new Error(`The input media source ${hostPath} was supplied with conflicting hashes.`);
                }
                throw new Error(`The input media source ${hostPath} was supplied more than once.`);
            }
            const sourceInfo = await fileSystem.lstat(hostPath).catch((error: unknown) => {
                throw new Error(`The Windows test input ${hostPath} could not be inspected: ${String(error)}.`);
            });
            if (sourceInfo.isSymbolicLink()) {
                throw new Error(`The Windows test input ${hostPath} is a symbolic link.`);
            }
            if (!sourceInfo.isFile()) {
                throw new Error(`The Windows test input ${hostPath} is not a regular file.`);
            }
            const sourceRealPath = await fileSystem.realpath(hostPath);
            const realInfo = await fileSystem.stat(sourceRealPath);
            if (!realInfo.isFile()) {
                throw new Error(`The Windows test input ${hostPath} does not resolve to a regular file.`);
            }
            const expectedSha256 = source.sha256.toLowerCase();
            const actualSha256 = (await hashFile(sourceRealPath)).toLowerCase();
            if (actualSha256 !== expectedSha256) {
                throw new Error(`The Windows test input ${hostPath} hashes to ${actualSha256}, expected ${expectedSha256}.`);
            }
            const fileName = mediaFileName(expectedSha256);
            const existingRealPath = realPathToMediaFile.get(sourceRealPath);
            if (existingRealPath !== undefined && existingRealPath !== fileName) {
                throw new Error(`The Windows test input ${hostPath} conflicts with another source after resolving its path.`);
            }
            hostPathToMediaFile.set(hostPath, fileName);
            realPathToMediaFile.set(sourceRealPath, fileName);
            if (mediaFileNames.has(fileName)) {
                continue;
            }
            const destinationPath = path.join(stagingDirectory, fileName);
            if (await pathIsPresent(fileSystem, destinationPath)) {
                throw new Error(`The input media file ${fileName} conflicts with an existing staging entry.`);
            }
            await fileSystem.copyFile(sourceRealPath, destinationPath, constants.COPYFILE_FICLONE);
            const stagedSha256 = (await hashFile(destinationPath)).toLowerCase();
            if (stagedSha256 !== expectedSha256) {
                throw new Error(`The Windows test input ${hostPath} changed while it was copied to the input media staging directory.`);
            }
            mediaFileNames.add(fileName);
        }

        const marker = markerContents([...mediaFileNames]);
        const markerSha256 = createHash('sha256').update(marker).digest('hex');
        await fileSystem.writeFile(
            path.join(stagingDirectory, WINDOWS_TEST_INPUT_MEDIA_MARKER_FILE),
            marker,
            'utf8',
        );
        const result = await options.runner.run(
            options.hdiutilPath ?? DEFAULT_HDIUTIL_PATH,
            [
                'makehybrid',
                '-iso',
                '-joliet',
                '-default-volume-name',
                WINDOWS_TEST_INPUT_MEDIA_VOLUME_NAME,
                '-o',
                outputPath,
                stagingDirectory,
            ],
            {timeoutMs: options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS},
        );
        if (result.exitCode !== 0 || result.timedOut) {
            throw new Error(`hdiutil could not build Windows test input media at ${outputPath}: ${result.stderr.trim()}`);
        }
        outputWasCreated = await pathIsPresent(fileSystem, outputPath);
        if (!outputWasCreated) {
            throw new Error(`hdiutil reported success but did not create Windows test input media at ${outputPath}.`);
        }
        const outputInfo = await fileSystem.stat(outputPath);
        if (!outputInfo.isFile()) {
            throw new Error(`The Windows test input media output ${outputPath} is not a regular file.`);
        }
        return {
            isoPath: outputPath,
            volumeName: WINDOWS_TEST_INPUT_MEDIA_VOLUME_NAME,
            markerFileName: WINDOWS_TEST_INPUT_MEDIA_MARKER_FILE,
            markerSha256,
            hostPathToMediaFile,
        };
    } catch (error) {
        if (outputWasCreated || await pathIsPresent(fileSystem, outputPath)) {
            await fileSystem.rm(outputPath, {force: true});
        }
        throw error;
    } finally {
        await fileSystem.rm(stagingDirectory, {
            force: true,
            recursive: true,
        });
    }
}
