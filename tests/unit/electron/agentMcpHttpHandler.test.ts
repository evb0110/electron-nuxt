import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpHandler } from '@electron/features/agent/mcp/createHttpHandler';
import type { IProcessMcpRequestOptions } from '@electron/features/agent/mcp/mcpServerCore';

const servers: Server[] = [];

function asRecord(value: unknown) {
    expect(value).toBeTypeOf('object');
    expect(value).not.toBeNull();
    return value as Record<string, unknown>;
}

function getErrorRecord(value: unknown) {
    const record = asRecord(value);
    return asRecord(record.error);
}

function createOptions(): IProcessMcpRequestOptions {
    return {
        identity: {
            name: 'evb_viewer_dev',
            title: 'EVB Viewer Dev',
            appName: 'EVB Viewer Dev',
            version: 'test',
            isPackaged: false,
            userDataPath: null,
            host: '127.0.0.1',
            port: 0,
        },
        getWorkspaceSnapshot: vi.fn(),
        runCommand: vi.fn(),
        inspectDocumentText: vi.fn(),
        searchDocument: vi.fn(),
        readDocumentPages: vi.fn(),
    };
}

async function listen(handler: ReturnType<typeof createHttpHandler>) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
}

describe('createHttpHandler', () => {
    afterEach(async () => {
        await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
            server.close(() => resolve());
        })));
    });

    it('requires an explicit bearer token by default', async () => {
        const url = await listen(createHttpHandler(createOptions()));

        const response = await fetch(url, {
            method: 'POST',
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            }),
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Unauthorized.' });
    });

    it('accepts authorized JSON-RPC requests', async () => {
        const url = await listen(createHttpHandler(createOptions(), { bearerToken: 'secret' }));

        const response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: 'Bearer secret' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            }),
        });
        const body = await response.json() as { result?: unknown };

        expect(response.status).toBe(200);
        expect(JSON.stringify(body.result)).toContain('evb_workspace_snapshot');
    });

    it('rejects browser-origin requests unless explicitly allowed', async () => {
        const url = await listen(createHttpHandler(createOptions(), { bearerToken: 'secret' }));

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer secret',
                Origin: 'https://example.test',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            }),
        });

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'Browser-origin MCP requests are not allowed.' });
    });

    it('can explicitly allow browser-origin requests for trusted test harnesses', async () => {
        const url = await listen(createHttpHandler(createOptions(), {
            bearerToken: 'secret',
            allowBrowserOrigins: true,
        }));

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer secret',
                Origin: 'https://example.test',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            }),
        });

        expect(response.status).toBe(200);
    });

    it('rejects oversized JSON-RPC batches before processing', async () => {
        const options = createOptions();
        const url = await listen(createHttpHandler(options, { bearerToken: 'secret' }));
        const batch = Array.from({ length: 33 }, (_, index) => ({
            jsonrpc: '2.0',
            id: index + 1,
            method: index === 0 ? 'tools/call' : 'tools/list',
            ...(index === 0
                ? {params: {
                    name: 'evb_workspace_snapshot',
                    arguments: {},
                }}
                : {}),
        }));

        const response = await fetch(url, {
            method: 'POST',
            headers: { Authorization: 'Bearer secret' },
            body: JSON.stringify(batch),
        });
        const error = getErrorRecord(await response.json());

        expect(response.status).toBe(400);
        expect(error).toMatchObject({
            code: -32600,
            message: 'JSON-RPC batch is too large.',
        });
        expect(options.getWorkspaceSnapshot).not.toHaveBeenCalled();
    });
});
