import {
    spawn,
    type ChildProcessWithoutNullStreams,
} from 'child_process';
import { app } from 'electron';
import { isRecord } from '@contracts/runtimeGuards';
import { getErrorMessage } from '@electron/utils/error';
import { createLogger } from '@electron/utils/createLogger';

const logger = createLogger('agent-codex-assistant');
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;

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

export class CodexAppServerClient {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<TAppServerJsonRpcId, IPendingAppServerRequest>();
    private nextId = 1;
    private stdoutBuffer = '';
    private stderrBuffer = '';
    private closed = false;

    constructor(
        codexPath: string,
        env: NodeJS.ProcessEnv,
        cwd: string,
        private readonly onNotification: (notification: ICodexAppServerNotification) => void,
        private readonly onExit: (message: string) => void,
    ) {
        this.child = spawn(codexPath, [
            'app-server',
            '--listen',
            'stdio://',
        ], {
            cwd,
            env,
            windowsHide: true,
        });

        this.child.stdout.setEncoding('utf8');
        this.child.stderr.setEncoding('utf8');
        this.child.stdout.on('data', (chunk: string | Buffer) => this.handleStdout(String(chunk)));
        this.child.stderr.on('data', (chunk: string | Buffer) => this.handleStderr(String(chunk)));
        this.child.on('error', error => this.failAll(`Codex app-server failed: ${getErrorMessage(error)}`));
        this.child.on('close', (exitCode) => {
            const detail = this.stderrBuffer.trim();
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
                reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                timeout,
                resolve,
                reject,
            });

            this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
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
            });
        });
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
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    respond(id: unknown, result: unknown) {
        if (this.closed) {
            return;
        }

        this.child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id,
            result,
        })}\n`);
    }

    shutdown() {
        this.closed = true;
        for (const [
            id,
            pending,
        ] of this.pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Codex app-server is shutting down.'));
            this.pending.delete(id);
        }
        this.child.kill();
    }

    private handleStdout(chunk: string) {
        this.stdoutBuffer += chunk;
        const lines = this.stdoutBuffer.split(/\r?\n/u);
        this.stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            this.handleMessage(trimmed);
        }
    }

    private handleStderr(chunk: string) {
        this.stderrBuffer += chunk;
        const lines = chunk.split(/\r?\n/u)
            .map(line => line.trim())
            .filter(Boolean);
        for (const line of lines) {
            logger.info(`[app-server] ${line}`);
        }
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

    private failAll(message: string) {
        if (this.closed) {
            return;
        }

        this.closed = true;
        for (const [
            id,
            pending,
        ] of this.pending) {
            clearTimeout(pending.timeout);
            pending.reject(new Error(message));
            this.pending.delete(id);
        }
        this.onExit(message);
    }
}
