/// <reference types="node" />

import {
    defineEventHandler,
    readBody,
    setResponseStatus,
} from 'h3';
import { writeFile } from 'node:fs/promises';

const TRACE_FILE_PATH = '/tmp/evb-pdf-annotation-save-trace.jsonl';
const MAX_TRACE_BYTES = 2_000_000;

function isTraceBody(value: unknown): value is { data: string } {
    return (
        typeof value === 'object'
        && value !== null
        && typeof (value as { data?: unknown }).data === 'string'
    );
}

export default defineEventHandler(async (event) => {
    if (process.env.NODE_ENV === 'production') {
        setResponseStatus(event, 404);
        return { ok: false };
    }

    const body: unknown = await readBody(event);
    if (!isTraceBody(body) || body.data.length > MAX_TRACE_BYTES) {
        setResponseStatus(event, 400);
        return { ok: false };
    }

    await writeFile(TRACE_FILE_PATH, body.data, 'utf8');
    return {
        ok: true,
        path: TRACE_FILE_PATH,
    };
});
