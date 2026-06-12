import type {
    IncomingMessage,
    ServerResponse,
} from 'http';
import { getErrorMessage } from '@electron/utils/error';
import {
    createHealthResponse,
    processMcpRequest,
    type IProcessMcpRequestOptions,
} from '@electron/features/agent/mcp/mcpServerCore';
import {
    createErrorResponse,
    type IJsonRpcResponse,
} from '@electron/features/agent/mcp/mcpJsonRpc';

const MAX_JSON_RPC_BODY_BYTES = 1024 * 1024;

interface IHttpHandlerOptions {bearerToken?: string | null;}

function readRequestBody(request: IncomingMessage) {
    return new Promise<string>((resolve, reject) => {
        let body = '';

        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
            body += chunk;
            if (body.length > MAX_JSON_RPC_BODY_BYTES) {
                reject(new Error('JSON-RPC request body is too large.'));
                request.destroy();
            }
        });
        request.on('end', () => resolve(body));
        request.on('error', reject);
    });
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(payload));
}

function writeNoContent(response: ServerResponse) {
    response.writeHead(202, {'Cache-Control': 'no-store'});
    response.end();
}

function isAuthorizedMcpRequest(request: IncomingMessage, bearerToken: string | null | undefined) {
    if (!bearerToken) {
        return true;
    }

    const header = request.headers.authorization;
    return typeof header === 'string' && header === `Bearer ${bearerToken}`;
}

export function createHttpHandler(
    options: IProcessMcpRequestOptions,
    httpOptions: IHttpHandlerOptions = {},
) {
    return async (request: IncomingMessage, response: ServerResponse) => {
        if (request.method === 'GET' && request.url === '/health') {
            if (!isAuthorizedMcpRequest(request, httpOptions.bearerToken)) {
                writeJson(response, 401, { error: 'Unauthorized.' });
                return;
            }
            writeJson(response, 200, createHealthResponse(options.identity));
            return;
        }

        if (request.method !== 'POST') {
            writeJson(response, 405, { error: 'Only POST JSON-RPC requests are supported.' });
            return;
        }

        if (!isAuthorizedMcpRequest(request, httpOptions.bearerToken)) {
            writeJson(response, 401, { error: 'Unauthorized.' });
            return;
        }

        try {
            const body = await readRequestBody(request);
            const parsed: unknown = JSON.parse(body);
            if (Array.isArray(parsed)) {
                const processedResponses = await Promise.all(
                    parsed.map(item => processMcpRequest(item, options)),
                );
                const responses: IJsonRpcResponse[] = [];
                for (const item of processedResponses) {
                    if (item !== null) {
                        responses.push(item);
                    }
                }

                if (responses.length === 0) {
                    writeNoContent(response);
                    return;
                }
                writeJson(response, 200, responses);
                return;
            }

            const result = await processMcpRequest(parsed, options);
            if (!result) {
                writeNoContent(response);
                return;
            }
            writeJson(response, 200, result);
        } catch (error) {
            writeJson(response, 400, createErrorResponse(null, -32700, getErrorMessage(error)));
        }
    };
}
