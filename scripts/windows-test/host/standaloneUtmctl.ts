import {execFile} from 'node:child_process';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {DEFAULT_UTMCTL_PATH} from '@scripts/windows-test/host/utmctlClient';
import type {IWindowsTestHostLayout} from '@scripts/windows-test/contracts/windowsTestPaths';

export const STANDALONE_UTMCTL_DIRECTORY = 'utmctl-probe';
export const STANDALONE_UTMCTL_FILE_NAME = 'utmctl';
export const STANDALONE_UTMCTL_METADATA_FILE_NAME = 'utmctl.json';
export const STANDALONE_UTMCTL_SCHEMA_VERSION = 1;

const PREPARE_REMEDY = 'Run pnpm windows:test:prepare before running the Windows test lane.';
const EXECUTABLE_MODE_MASK = 0o111;
const PRESERVED_MODE_MASK = 0o7777;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const execFileAsync = promisify(execFile);

export interface IStandaloneUtmctlPaths {
    directory: string;
    executable: string;
    metadata: string;
}

export interface IStandaloneUtmctlMetadata {
    schemaVersion: typeof STANDALONE_UTMCTL_SCHEMA_VERSION;
    sourcePath: string;
    sourceSha256: string;
    copyPath: string;
    copySha256: string;
    sourceMode: number;
    copyMode: number;
}

export type TStandaloneUtmctlSignatureVerifier = (filePath: string) => Promise<void>;

export interface IStandaloneUtmctlPreparationOptions {
    layout: IWindowsTestHostLayout;
    sourcePath?: string;
    verifyCodeSignature?: TStandaloneUtmctlSignatureVerifier;
}

export interface IStandaloneUtmctlResolutionOptions {
    layout: IWindowsTestHostLayout;
    sourcePath?: string;
}

export interface IStandaloneUtmctlPreparationResult {
    sourcePath: string;
    standaloneUtmctlPath: string;
    metadataPath: string;
    sourceSha256: string;
    copySha256: string;
}

export function standaloneUtmctlPaths(layout: IWindowsTestHostLayout): IStandaloneUtmctlPaths {
    const directory = path.join(layout.toolsCacheDir, STANDALONE_UTMCTL_DIRECTORY);
    return {
        directory,
        executable: path.join(directory, STANDALONE_UTMCTL_FILE_NAME),
        metadata: path.join(directory, STANDALONE_UTMCTL_METADATA_FILE_NAME),
    };
}

function preparationError(detail: string): Error {
    return new Error(`${detail} ${PREPARE_REMEDY}`);
}

function expectedSourcePath(sourcePath: string | undefined) {
    return path.resolve(sourcePath ?? DEFAULT_UTMCTL_PATH);
}

async function inspectExecutable(filePath: string, label: string) {
    const fileStats = await lstat(filePath).catch(error => {
        throw preparationError(`${label} ${filePath} is unavailable: ${error instanceof Error ? error.message : String(error)}.`);
    });
    if (!fileStats.isFile()) {
        throw preparationError(`${label} ${filePath} is not a regular file.`);
    }
    const mode = fileStats.mode & PRESERVED_MODE_MASK;
    if ((mode & EXECUTABLE_MODE_MASK) === 0) {
        throw preparationError(`${label} ${filePath} is not executable.`);
    }
    const bytes = await readFile(filePath).catch(error => {
        throw preparationError(`${label} ${filePath} could not be read: ${error instanceof Error ? error.message : String(error)}.`);
    });
    if (bytes.byteLength === 0) {
        throw preparationError(`${label} ${filePath} is empty.`);
    }
    return {
        mode,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
}

async function verifyMacCodeSignature(filePath: string) {
    if (process.platform !== 'darwin') {
        return;
    }
    try {
        await execFileAsync('/usr/bin/codesign', [
            '--verify',
            '--strict',
            filePath,
        ], {maxBuffer: 16 * 1024});
    } catch (error) {
        throw preparationError(`codesign --verify --strict rejected ${filePath}: ${error instanceof Error ? error.message : String(error)}.`);
    }
}

function parseMetadata(value: unknown, metadataPath: string): IStandaloneUtmctlMetadata {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw preparationError(`The standalone utmctl metadata ${metadataPath} is not an object.`);
    }
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== STANDALONE_UTMCTL_SCHEMA_VERSION
        || typeof record.sourcePath !== 'string'
        || typeof record.copyPath !== 'string'
        || typeof record.sourceSha256 !== 'string'
        || typeof record.copySha256 !== 'string'
        || !SHA256_PATTERN.test(record.sourceSha256)
        || !SHA256_PATTERN.test(record.copySha256)
        || typeof record.sourceMode !== 'number'
        || !Number.isInteger(record.sourceMode)
        || typeof record.copyMode !== 'number'
        || !Number.isInteger(record.copyMode)) {
        throw preparationError(`The standalone utmctl metadata ${metadataPath} is malformed.`);
    }
    return {
        schemaVersion: STANDALONE_UTMCTL_SCHEMA_VERSION,
        sourcePath: record.sourcePath,
        sourceSha256: record.sourceSha256,
        copyPath: record.copyPath,
        copySha256: record.copySha256,
        sourceMode: record.sourceMode,
        copyMode: record.copyMode,
    };
}

async function readMetadata(metadataPath: string) {
    const raw = await readFile(metadataPath, 'utf8').catch(error => {
        throw preparationError(`The standalone utmctl metadata ${metadataPath} is unavailable: ${error instanceof Error ? error.message : String(error)}.`);
    });
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw preparationError(`The standalone utmctl metadata ${metadataPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
    }
    return parseMetadata(parsed, metadataPath);
}

export async function prepareStandaloneUtmctl(
    options: IStandaloneUtmctlPreparationOptions,
): Promise<IStandaloneUtmctlPreparationResult> {
    const sourcePath = expectedSourcePath(options.sourcePath);
    const paths = standaloneUtmctlPaths(options.layout);
    if (sourcePath === path.resolve(paths.executable)) {
        throw preparationError(`The standalone utmctl source and cache path are the same file ${sourcePath}.`);
    }
    await mkdir(paths.directory, {recursive: true});
    const source = await inspectExecutable(sourcePath, 'The installed utmctl source');
    const verifyCodeSignature = options.verifyCodeSignature ?? verifyMacCodeSignature;
    await verifyCodeSignature(sourcePath);

    const temporaryExecutable = `${paths.executable}.${randomUUID()}.tmp`;
    const temporaryMetadata = `${paths.metadata}.${randomUUID()}.tmp`;
    try {
        await copyFile(sourcePath, temporaryExecutable);
        await chmod(temporaryExecutable, source.mode);
        const copy = await inspectExecutable(temporaryExecutable, 'The standalone utmctl copy');
        if (copy.sha256 !== source.sha256) {
            throw preparationError(`The standalone utmctl copy ${temporaryExecutable} differs from its source.`);
        }
        if (copy.mode !== source.mode) {
            throw preparationError(`The standalone utmctl copy ${temporaryExecutable} has mode ${copy.mode.toString(8)}, expected ${source.mode.toString(8)}.`);
        }
        await verifyCodeSignature(temporaryExecutable);
        await rename(temporaryExecutable, paths.executable);

        const metadata: IStandaloneUtmctlMetadata = {
            schemaVersion: STANDALONE_UTMCTL_SCHEMA_VERSION,
            sourcePath,
            sourceSha256: source.sha256,
            copyPath: path.resolve(paths.executable),
            copySha256: copy.sha256,
            sourceMode: source.mode,
            copyMode: copy.mode,
        };
        await writeFile(temporaryMetadata, `${JSON.stringify(metadata, null, 4)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        await rename(temporaryMetadata, paths.metadata);
        return {
            sourcePath,
            standaloneUtmctlPath: paths.executable,
            metadataPath: paths.metadata,
            sourceSha256: source.sha256,
            copySha256: copy.sha256,
        };
    } finally {
        await rm(temporaryExecutable, {force: true});
        await rm(temporaryMetadata, {force: true});
    }
}

export async function resolvePreparedStandaloneUtmctl(
    options: IStandaloneUtmctlResolutionOptions,
): Promise<string> {
    const sourcePath = expectedSourcePath(options.sourcePath);
    const paths = standaloneUtmctlPaths(options.layout);
    const metadata = await readMetadata(paths.metadata);
    const resolvedCopyPath = path.resolve(paths.executable);
    if (path.resolve(metadata.sourcePath) !== sourcePath) {
        throw preparationError(`The standalone utmctl metadata records source ${metadata.sourcePath}, expected ${sourcePath}.`);
    }
    if (path.resolve(metadata.copyPath) !== resolvedCopyPath) {
        throw preparationError(`The standalone utmctl metadata records copy ${metadata.copyPath}, expected ${resolvedCopyPath}.`);
    }
    const source = await inspectExecutable(sourcePath, 'The installed utmctl source');
    const copy = await inspectExecutable(paths.executable, 'The standalone utmctl cache');
    if (source.mode !== metadata.sourceMode || copy.mode !== metadata.copyMode || source.mode !== copy.mode) {
        throw preparationError(`The standalone utmctl executable mode changed for ${paths.executable}.`);
    }
    if (source.sha256 !== metadata.sourceSha256
        || copy.sha256 !== metadata.copySha256
        || source.sha256 !== copy.sha256) {
        throw preparationError(`The standalone utmctl cache ${paths.executable} is stale or modified.`);
    }
    return paths.executable;
}
