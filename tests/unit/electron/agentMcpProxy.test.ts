import {
    describe,
    expect,
    it,
} from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

interface IProxyClient {
    send(message: Record<string, unknown>): void;
    sendRaw(payload: string): void;
    waitForResponse(id: string | number): Promise<IProxyResponse>;
    stop(): Promise<void>;
}

interface IProxyResponse {
    id?: string | number | null;
    result?: unknown;
    error?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
    expect(value).toBeTypeOf('object');
    expect(value).not.toBeNull();
    return value as Record<string, unknown>;
}

function createProxyClient(): IProxyClient {
    const child = spawn(process.execPath, [
        'scripts/evb-mcp-proxy.mjs',
        '--url',
        'http://127.0.0.1:9',
    ], {
        cwd: process.cwd(),
        stdio: [
            'pipe',
            'pipe',
            'pipe',
        ],
    });

    let buffer = '';
    const responses: IProxyResponse[] = [];
    const listeners = new Set<() => void>();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        while (true) {
            const lineEnd = buffer.indexOf('\n');
            if (lineEnd < 0) {
                break;
            }
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);
            if (line) {
                responses.push(JSON.parse(line) as IProxyResponse);
                for (const listener of listeners) {
                    listener();
                }
            }
        }
    });

    return {
        send(message: Record<string, unknown>) {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        sendRaw(payload: string) {
            child.stdin.write(payload);
        },
        async waitForResponse(id: string | number) {
            const existing = responses.find(response => response.id === id);
            if (existing) {
                return existing;
            }

            return new Promise<IProxyResponse>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    listeners.delete(check);
                    reject(new Error(`Timed out waiting for MCP response ${id}.`));
                }, 2000);
                const check = () => {
                    const response = responses.find(candidate => candidate.id === id);
                    if (!response) {
                        return;
                    }
                    clearTimeout(timeout);
                    listeners.delete(check);
                    resolve(response);
                };
                listeners.add(check);
            });
        },
        async stop() {
            child.stdin.end();
            const exited = await Promise.race([
                once(child, 'exit').then(() => true),
                new Promise<false>(resolve => setTimeout(() => resolve(false), 1000)),
            ]);
            if (!exited) {
                child.kill();
                await once(child, 'exit');
            }
        },
    };
}

describe('evb-mcp-proxy', () => {
    it('speaks newline-delimited stdio MCP for initialize and tools/list', async () => {
        const client = createProxyClient();

        try {
            client.send({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-11-25' },
            });
            client.send({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
            });
            client.send({
                jsonrpc: '2.0',
                id: 3,
                method: 'prompts/list',
            });

            const initialized = await client.waitForResponse(1);
            const tools = await client.waitForResponse(2);
            const prompts = await client.waitForResponse(3);
            const initializedResult = asRecord(initialized.result);
            const serverInfo = asRecord(initializedResult.serverInfo);

            expect(serverInfo).toMatchObject({
                name: 'evb_viewer_dev',
                title: 'EVB Viewer Dev',
            });
            expect(JSON.stringify(tools.result)).toContain('evb_viewer_open_documents');
            expect(JSON.stringify(tools.result)).toContain('evb_search_document');
            expect(JSON.stringify(initialized.result)).toContain('document.capture_page_image');
            expect(JSON.stringify(prompts.result)).toContain('evb_number_pages_from_printed_pages');
            expect(JSON.stringify(prompts.result)).toContain('evb_rebuild_verified_bookmarks');
        } finally {
            await client.stop();
        }
    });

    it('returns a tool-level unavailable result when the Electron endpoint is down', async () => {
        const client = createProxyClient();

        try {
            client.send({
                jsonrpc: '2.0',
                id: 'call',
                method: 'tools/call',
                params: {
                    name: 'evb_workspace_snapshot',
                    arguments: {},
                },
            });

            const response = await client.waitForResponse('call');
            const result = asRecord(response.result);
            const structuredContent = asRecord(result.structuredContent);

            expect(result.isError).toBe(true);
            expect(structuredContent.error).toContain('not reachable');
        } finally {
            await client.stop();
        }
    });

    it('recovers after a malformed Content-Length frame', async () => {
        const client = createProxyClient();

        try {
            client.sendRaw('Content-Length: nope\r\n\r\n');
            client.send({
                jsonrpc: '2.0',
                id: 'after-bad-frame',
                method: 'ping',
            });

            await expect(client.waitForResponse('after-bad-frame')).resolves.toMatchObject({
                id: 'after-bad-frame',
                result: {},
            });
        } finally {
            await client.stop();
        }
    });
});
