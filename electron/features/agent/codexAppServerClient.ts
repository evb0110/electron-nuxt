import {
    spawn,
    type ChildProcess,
} from 'child_process';
import { app } from 'electron';
import { isRecord } from '@contracts/runtimeGuards';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';
import { appendTextChunkWithByteCap } from '@electron/native-tools/appendTextChunkWithByteCap';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import {
    createDetachedChildProcessSpawnOptions,
    terminateDetachedChildProcess,
} from '@electron/utils/nativeChildProcess';
import { registerMainOperation } from '@electron/operation-lifecycle/mainOperationLifecycle';

const logger = createLogger('agent-codex-assistant');
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const APP_SERVER_MAX_STDOUT_RECORD_BYTES = parseIntegerEnv(
    'EVB_CODEX_APP_SERVER_MAX_STDOUT_RECORD_BYTES',
    32 * 1024 * 1024,
    1_024,
);
const APP_SERVER_MAX_STDERR_BYTES = parseIntegerEnv('EVB_CODEX_APP_SERVER_MAX_STDERR_BYTES', 262_144, 1_024);
const APP_SERVER_SHUTDOWN_GRACE_MS = parseIntegerEnv('EVB_CODEX_APP_SERVER_SHUTDOWN_GRACE_MS', 1_000, 250);
const APP_SERVER_SHUTDOWN_CLOSE_TIMEOUT_MS = parseIntegerEnv('EVB_CODEX_APP_SERVER_SHUTDOWN_CLOSE_TIMEOUT_MS', 500, 100);

type TAppServerJsonRpcId = number;

interface IAppServerJsonRpcResponse {
    id?: unknown;
    result?: unknown;
    error?: {
        code?: number;
        message?: string;
        data?: unknown;
    };
}

export interface ICodexAppServerNotification {
    method?: unknown;
    params?: unknown;
}

interface IPendingAppServerRequest {
    method: string;
    timeout: NodeJS.Timeout;
    resolve(value: unknown): void;
    reject(error: Error): void;
}

type TAppServerResponseDecoder<T> = (value: unknown) => T | null;

export class CodexAppServerRequestTimeoutError extends Error {
    readonly method: string;
    readonly timeoutMs: number;

    constructor(method: string, timeoutMs: number) {
        super(`${method} timed out after ${timeoutMs}ms.`);
        this.name = 'CodexAppServerRequestTimeoutError';
        this.method = method;
        this.timeoutMs = timeoutMs;
    }
}

export function isCodexAppServerRequestTimeoutError(error: unknown): error is CodexAppServerRequestTimeoutError {
    return error instanceof CodexAppServerRequestTimeoutError;
}

export class CodexAppServerRecordTooLargeError extends Error {
    readonly maxBytes: number;

    constructor(maxBytes: number) {
        super(`Codex app-server JSON-RPC record exceeded ${maxBytes} bytes.`);
        this.name = 'CodexAppServerRecordTooLargeError';
        this.maxBytes = maxBytes;
    }
}

export class CodexAppServerClient {
    private readonly child: ChildProcess;
    private readonly stdin: NonNullable<ChildProcess['stdin']>;
    private readonly stdout: NonNullable<ChildProcess['stdout']>;
    private readonly stderr: NonNullable<ChildProcess['stderr']>;
    private readonly pending = new Map<TAppServerJsonRpcId, IPendingAppServerRequest>();
    private nextId = 1;
    private stdoutBuffer = '';
    private stdoutBufferBytes = 0;
    private stderrBuffer = '';
    private stderrTruncated = false;
    private closed = false;
    private shutdownPromise: Promise<void> | null = null;
    private readonly closePromise: Promise<void>;
    private resolveClosePromise: () => void = () => undefined;
    private readonly lifecycleOperation = registerMainOperation({
        kind: 'resource-cleanup',
        cancel: () => {
            void this.shutdown();
        },
    });

    constructor(
        codexPath: string,
        env: NodeJS.ProcessEnv,
        cwd: string,
        private readonly onNotification: (notification: ICodexAppServerNotification) => void,
        private readonly onExit: (message: string) => void,
    ) {
        this.closePromise = new Promise(resolve => {
            this.resolveClosePromise = resolve;
        });
        const child = spawn(codexPath, [
            'app-server',
            '--listen',
            'stdio://',
        ], createDetachedChildProcessSpawnOptions({
            cwd,
            env,
            windowsHide: true,
        }));
        if (!child.stdin || !child.stdout || !child.stderr) {
            this.lifecycleOperation.complete();
            throw new Error('Codex app-server stdio pipes were not created.');
        }
        this.child = child;
        this.stdin = child.stdin;
        this.stdout = child.stdout;
        this.stderr = child.stderr;

        this.stdout.setEncoding('utf8');
        this.stderr.setEncoding('utf8');
        this.stdout.on('data', (chunk: string | Buffer) => this.handleStdout(String(chunk)));
        this.stderr.on('data', (chunk: string | Buffer) => this.handleStderr(String(chunk)));
        this.stdin.on('error', error => this.failAll(`Codex app-server stdin failed: ${getErrorMessage(error)}`));
        this.child.on('error', error => this.failAll(`Codex app-server failed: ${getErrorMessage(error)}`));
        this.child.on('close', (exitCode) => {
            this.resolveClosePromise();
            this.lifecycleOperation.complete();
            const detail = this.getStderrDetail();
            this.failAll(`Codex app-server exited${exitCode === null ? '' : ` with code ${exitCode}`}${detail ? `: ${detail}` : '.'}`);
        });
    }

    async initialize() {
        await this.request('initialize', {
            clientInfo: {
                name: 'evb-viewer',
                title: 'EVB Viewer',
                version: app.getVersion(),
            },
            capabilities: { experimentalApi: true },
        });
        this.notify('initialized');
    }

    request(method: string, params: unknown, timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS) {
        if (this.closed) {
            return Promise.reject(new Error('Codex app-server is not running.'));
        }

        const id = this.nextId;
        this.nextId += 1;
        const payload = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };

        return new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new CodexAppServerRequestTimeoutError(method, timeoutMs));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                timeout,
                resolve,
                reject,
            });

            this.writeLine(payload, (error) => {
                if (!error) {
                    return;
                }
                const pending = this.pending.get(id);
                if (!pending) {
                    return;
                }
                clearTimeout(pending.timeout);
                this.pending.delete(id);
                pending.reject(new Error(`Failed to send ${method}: ${getErrorMessage(error)}`));
                this.failAll(`Codex app-server stdin failed: ${getErrorMessage(error)}`);
            });
        });
    }

    // Fallow cannot trace calls through the runtime's client contract.
    // fallow-ignore-next-line unused-class-member
    async requestDecoded<T>(
        method: string,
        params: unknown,
        decode: TAppServerResponseDecoder<T>,
        timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS,
    ) {
        const response = await this.request(method, params, timeoutMs);
        const decoded = decode(response);
        if (decoded === null) {
            throw new Error(`Codex app-server returned an invalid ${method} response.`);
        }
        return decoded;
    }

    notify(method: string, params?: unknown) {
        if (this.closed) {
            return;
        }

        const payload = params === undefined
            ? {
                jsonrpc: '2.0',
                method,
            }
            : {
                jsonrpc: '2.0',
                method,
                params,
            };
        this.writeLine(payload, (error) => {
            if (error) {
                this.failAll(`Codex app-server stdin failed while sending ${method}: ${getErrorMessage(error)}`);
            }
        });
    }

    respond(id: unknown, result: unknown) {
        if (this.closed) {
            return;
        }

        this.writeLine({
            jsonrpc: '2.0',
            id,
            result,
        }, (error) => {
            if (error) {
                this.failAll(`Codex app-server stdin failed while sending response: ${getErrorMessage(error)}`);
            }
        });
    }

    async shutdown() {
        if (this.shutdownPromise) {
            return this.shutdownPromise;
        }

        this.closed = true;
        for (const [
            id,
            pending,
        ] of this.pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Codex app-server is shutting down.'));
            this.pending.delete(id);
        }
        this.shutdownPromise = this.terminateChild();
        return this.shutdownPromise;
    }

    private async terminateChild() {
        try {
            await terminateDetachedChildProcess(this.child, APP_SERVER_SHUTDOWN_GRACE_MS);
            await this.waitForClose(APP_SERVER_SHUTDOWN_CLOSE_TIMEOUT_MS);
        } finally {
            this.lifecycleOperation.complete();
        }
    }

    private async waitForClose(timeoutMs: number) {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        try {
            await Promise.race([
                this.closePromise,
                new Promise<void>(resolve => {
                    timeoutHandle = setTimeout(resolve, timeoutMs);
                    timeoutHandle.unref?.();
                }),
            ]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    private writeLine(
        payload: unknown,
        callback: (error: Error | null) => void,
    ) {
        try {
            this.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
                callback(error ?? null);
            });
        } catch (error) {
            callback(error instanceof Error ? error : new Error(getErrorMessage(error)));
        }
    }

    private handleStdout(chunk: string) {
        let start = 0;
        for (;;) {
            const newlineIndex = chunk.indexOf('\n', start);
            const end = newlineIndex < 0 ? chunk.length : newlineIndex;
            const segment = chunk.slice(start, end);
            if (!this.appendStdoutRecordSegment(segment)) {
                return;
            }
            if (newlineIndex < 0) {
                return;
            }
            const line = this.stdoutBuffer.trim();
            this.stdoutBuffer = '';
            this.stdoutBufferBytes = 0;
            if (line) {
                this.handleMessage(line);
            }
            start = newlineIndex + 1;
        }
    }

    private appendStdoutRecordSegment(segment: string) {
        const nextBytes = this.stdoutBufferBytes + Buffer.byteLength(segment);
        if (nextBytes > APP_SERVER_MAX_STDOUT_RECORD_BYTES) {
            const error = new CodexAppServerRecordTooLargeError(APP_SERVER_MAX_STDOUT_RECORD_BYTES);
            this.failAll(error.message, error);
            this.shutdownPromise ??= this.terminateChild();
            void this.shutdownPromise.catch(terminationError => {
                logger.warn(`Failed to terminate oversized Codex app-server record: ${getErrorMessage(terminationError)}`);
            });
            return false;
        }
        this.stdoutBuffer += segment;
        this.stdoutBufferBytes = nextBytes;
        return true;
    }

    private handleStderr(chunk: string) {
        const appended = appendTextChunkWithByteCap(this.stderrBuffer, Buffer.from(chunk), APP_SERVER_MAX_STDERR_BYTES);
        this.stderrBuffer = appended.text;
        this.stderrTruncated = this.stderrTruncated || appended.truncated;
        const lines = chunk.split(/\r?\n/u)
            .map(line => line.trim())
            .filter(Boolean);
        for (const line of lines) {
            logger.info(`[app-server] ${line}`);
        }
    }

    private getStderrDetail() {
        const detail = this.stderrBuffer.trim();
        if (!detail) {
            return '';
        }

        return this.stderrTruncated
            ? `[stderr truncated to ${APP_SERVER_MAX_STDERR_BYTES} bytes]\n${detail}`
            : detail;
    }

    private handleMessage(line: string) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (error) {
            logger.warn(`Ignoring non-JSON app-server output: ${getErrorMessage(error)}`);
            return;
        }

        if (!isRecord(parsed)) {
            return;
        }

        if (typeof parsed.id === 'number' && !('method' in parsed)) {
            this.handleResponse(parsed);
            return;
        }

        if (typeof parsed.method === 'string' && 'id' in parsed) {
            this.handleServerRequest(parsed);
            return;
        }

        if (typeof parsed.method === 'string') {
            this.onNotification(parsed);
        }
    }

    private handleResponse(response: IAppServerJsonRpcResponse) {
        const id = typeof response.id === 'number' ? response.id : null;
        if (id === null) {
            return;
        }

        const pending = this.pending.get(id);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pending.delete(id);
        if (response.error) {
            pending.reject(new Error(response.error.message && response.error.message.length > 0
                ? response.error.message
                : `${pending.method} failed.`));
            return;
        }
        pending.resolve(response.result);
    }

    private handleServerRequest(request: Record<string, unknown>) {
        const method = typeof request.method === 'string' ? request.method : '';
        logger.warn(`Denying unexpected Codex app-server request: ${method}`);
        if (method === 'item/commandExecution/requestApproval') {
            this.respond(request.id, { decision: 'denied' });
            return;
        }
        if (method === 'item/fileChange/requestApproval') {
            this.respond(request.id, { decision: 'denied' });
            return;
        }
        if (method === 'item/tool/call') {
            this.respond(request.id, {
                contentItems: [{
                    type: 'text',
                    text: 'EVB Assistant does not expose dynamic tools.',
                }],
                success: false,
            });
            return;
        }
        if (method === 'mcpServer/elicitation/request') {
            this.respond(request.id, { action: 'decline' });
            return;
        }
        this.respond(request.id, null);
    }

    private failAll(message: string, error?: Error) {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.lifecycleOperation.complete();
        for (const [
            id,
            pending,
        ] of this.pending) {
            clearTimeout(pending.timeout);
            pending.reject(error ?? new Error(message));
            this.pending.delete(id);
        }
        this.onExit(message);
    }
}
