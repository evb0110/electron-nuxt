import {
    closeSync,
    mkdirSync,
    openSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import {
    isAbsolute,
    join,
    relative,
} from 'node:path';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    getCurrentSessionName,
    validateSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';

export const DEV_OUTPUT_TEE_DIR_ENV = 'EVB_DEV_OUTPUT_TEE_DIR';
export const DEV_OUTPUT_TEE_DISABLED_ENV = 'EVB_DEV_OUTPUT_TEE_DISABLED';
export const devServerOutputTeeBaseDir = join(projectRoot, '.devkit', 'scratch', 'dev-server-logs');

type TOutputStreamName = 'stdout' | 'stderr';
type TOutputChunk = string | Uint8Array;

interface ICreateDevServerOutputTeeOptions {
    sessionName?: string;
    runDir?: string;
    baseDir?: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    pid?: number;
    metadataFileName?: string;
    owner?: string;
}

export interface IDevServerOutputTee {
    readonly runDir: string;
    readonly relativeRunDir: string;
    readonly sessionName: string;
    write(source: string, stream: TOutputStreamName, chunk: TOutputChunk): void;
    writeLine(source: string, stream: TOutputStreamName, line: string): void;
    installProcessStreamTee(source?: string): void;
    close(): void;
}

let activeTee: DevServerOutputTee | null = null;

function isTruthyEnvValue(value: string | undefined) {
    return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

export function formatDevServerOutputTeeTimestamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/gu, '-');
}

export function sanitizeDevServerOutputFileStem(value: string) {
    const sanitized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    if (!sanitized || sanitized === '.' || sanitized === '..') {
        throw new Error(`Invalid dev output tee file stem: ${value}`);
    }
    return sanitized;
}

function resolveRunDir(options: Required<Pick<ICreateDevServerOutputTeeOptions, 'env' | 'now' | 'pid' | 'baseDir' | 'sessionName'>> & Pick<ICreateDevServerOutputTeeOptions, 'runDir'>) {
    const configuredRunDir = options.runDir ?? options.env[DEV_OUTPUT_TEE_DIR_ENV];
    if (configuredRunDir) {
        return isAbsolute(configuredRunDir)
            ? configuredRunDir
            : join(projectRoot, configuredRunDir);
    }

    return join(
        options.baseDir,
        options.sessionName,
        `${formatDevServerOutputTeeTimestamp(options.now)}-pid-${options.pid}`,
    );
}

function toBuffer(chunk: TOutputChunk) {
    return typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
}

function writeJsonFile(filePath: string, value: unknown) {
    writeFileSync(filePath, `${JSON.stringify(value, null, 4)}\n`);
}

function createRelativeRunDir(runDir: string) {
    const relativePath = relative(projectRoot, runDir);
    return relativePath && !relativePath.startsWith('..') ? relativePath : runDir;
}

function writeLatestRunPointers(options: {
    baseDir: string;
    createdAt: string;
    runDir: string;
    relativeRunDir: string;
    sessionName: string;
}) {
    const payload = {
        schemaVersion: 1,
        createdAt: options.createdAt,
        sessionName: options.sessionName,
        runDir: options.runDir,
        relativeRunDir: options.relativeRunDir,
    };

    mkdirSync(options.baseDir, { recursive: true });
    writeJsonFile(join(options.baseDir, 'latest-run.json'), payload);

    const sessionPointerDir = join(options.baseDir, options.sessionName);
    mkdirSync(sessionPointerDir, { recursive: true });
    writeJsonFile(join(sessionPointerDir, 'latest-run.json'), payload);
}

class DevServerOutputTee implements IDevServerOutputTee {
    readonly runDir: string;
    readonly relativeRunDir: string;
    readonly sessionName: string;

    private readonly fileDescriptors = new Map<string, number>();
    private readonly restoreProcessStreams: Array<() => void> = [];
    private closed = false;

    constructor(options: Required<ICreateDevServerOutputTeeOptions>) {
        this.sessionName = validateSessionName(options.sessionName);
        this.runDir = resolveRunDir({
            env: options.env,
            now: options.now,
            pid: options.pid,
            baseDir: options.baseDir,
            sessionName: this.sessionName,
            ...(options.runDir ? { runDir: options.runDir } : {}),
        });
        this.relativeRunDir = createRelativeRunDir(this.runDir);
        mkdirSync(this.runDir, { recursive: true });

        const createdAt = options.now.toISOString();
        writeLatestRunPointers({
            baseDir: options.baseDir,
            createdAt,
            runDir: this.runDir,
            relativeRunDir: this.relativeRunDir,
            sessionName: this.sessionName,
        });
        writeJsonFile(join(this.runDir, options.metadataFileName), {
            schemaVersion: 1,
            owner: options.owner,
            createdAt,
            pid: options.pid,
            sessionName: this.sessionName,
            runDir: this.runDir,
            relativeRunDir: this.relativeRunDir,
        });
    }

    write(source: string, stream: TOutputStreamName, chunk: TOutputChunk) {
        if (this.closed) {
            return;
        }

        const stem = sanitizeDevServerOutputFileStem(source);
        const buffer = toBuffer(chunk);
        this.writeFile(`${stem}.${stream}.log`, buffer);
        this.writeCombinedFile(stem, stream, buffer);
    }

    writeLine(source: string, stream: TOutputStreamName, line: string) {
        this.write(source, stream, `${line}\n`);
    }

    installProcessStreamTee(source = 'electron-run-launcher') {
        if (this.closed || this.restoreProcessStreams.length > 0) {
            return;
        }

        this.restoreProcessStreams.push(
            this.patchWriteStream(process.stdout, chunk => this.write(source, 'stdout', chunk)),
            this.patchWriteStream(process.stderr, chunk => this.write(source, 'stderr', chunk)),
        );
    }

    close() {
        if (this.closed) {
            return;
        }

        this.closed = true;
        for (const restore of this.restoreProcessStreams.splice(0).reverse()) {
            restore();
        }
        for (const fd of this.fileDescriptors.values()) {
            try {
                closeSync(fd);
            } catch {}
        }
        this.fileDescriptors.clear();
    }

    private patchWriteStream(
        stream: NodeJS.WriteStream,
        record: (chunk: TOutputChunk) => void,
    ) {
        const originalWrite = stream.write.bind(stream);
        stream.write = (chunk: TOutputChunk, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
            try {
                record(chunk);
            } catch {}

            if (typeof encoding === 'function') {
                return originalWrite(chunk, encoding);
            }
            return originalWrite(chunk, encoding, callback);
        };

        return () => {
            stream.write = originalWrite;
        };
    }

    private openFile(fileName: string) {
        const existing = this.fileDescriptors.get(fileName);
        if (existing !== undefined) {
            return existing;
        }

        const fd = openSync(join(this.runDir, fileName), 'a');
        this.fileDescriptors.set(fileName, fd);
        return fd;
    }

    private writeFile(fileName: string, buffer: Buffer) {
        try {
            writeSync(this.openFile(fileName), buffer);
        } catch {}
    }

    private writeCombinedFile(stem: string, stream: TOutputStreamName, buffer: Buffer) {
        const prefix = `[${new Date().toISOString()} ${stream}] `;
        const text = buffer.toString('utf8').replace(/^/gmu, prefix);
        this.writeFile(`${stem}.combined.log`, Buffer.from(text));
    }
}

export function createDevServerOutputTee(options: ICreateDevServerOutputTeeOptions & {allowDisabled: true}): IDevServerOutputTee | null;
export function createDevServerOutputTee(options?: ICreateDevServerOutputTeeOptions): IDevServerOutputTee;
export function createDevServerOutputTee(options: ICreateDevServerOutputTeeOptions & {allowDisabled?: boolean} = {}): IDevServerOutputTee | null {
    const env = options.env ?? process.env;
    if (isTruthyEnvValue(env[DEV_OUTPUT_TEE_DISABLED_ENV])) {
        if (!options.allowDisabled) {
            throw new Error('Dev output tee is disabled.');
        }
        return null;
    }

    const createOptions: Required<ICreateDevServerOutputTeeOptions> = {
        sessionName: options.sessionName ?? getCurrentSessionName(),
        runDir: options.runDir ?? env[DEV_OUTPUT_TEE_DIR_ENV] ?? '',
        baseDir: options.baseDir ?? devServerOutputTeeBaseDir,
        env,
        now: options.now ?? new Date(),
        pid: options.pid ?? process.pid,
        metadataFileName: options.metadataFileName ?? 'electron-run-tee.json',
        owner: options.owner ?? 'electron-run',
    };
    return new DevServerOutputTee({
        ...createOptions,
        ...(createOptions.runDir ? { runDir: createOptions.runDir } : {}),
    });
}

export function installDevServerOutputTee() {
    if (activeTee) {
        return activeTee;
    }

    const tee = createDevServerOutputTee({allowDisabled: true});
    if (!tee) {
        return null;
    }

    activeTee = tee as DevServerOutputTee;
    activeTee.installProcessStreamTee();
    process.once('exit', () => closeActiveDevServerOutputTee());
    return activeTee;
}

export function getActiveDevServerOutputTee() {
    return activeTee;
}

export function closeActiveDevServerOutputTee() {
    activeTee?.close();
    activeTee = null;
}
