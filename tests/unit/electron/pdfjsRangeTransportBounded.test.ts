import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getDocument,
    PDFDataRangeTransport,
    PDFWorker,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

const MEGABYTE = 1024 * 1024;
const PDF_SIZE = 17 * MEGABYTE;
const LARGE_PDF_SIZE = 2 * 1024 * 1024 * 1024;

interface IRangeRequest {
    begin: number;
    end: number;
}

function copyOverlap(
    target: Uint8Array,
    targetBegin: number,
    source: Uint8Array,
    sourceBegin: number,
) {
    const begin = Math.max(targetBegin, sourceBegin);
    const end = Math.min(
        targetBegin + target.byteLength,
        sourceBegin + source.byteLength,
    );
    if (end > begin) {
        target.set(
            source.subarray(begin - sourceBegin, end - sourceBegin),
            begin - targetBegin,
        );
    }
}

function createMalformedSparsePdf() {
    const encoder = new TextEncoder();
    const prefix = new Uint8Array(MEGABYTE);
    prefix.set(encoder.encode(
        '%PDF-1.7\n'
        + '1 0 obj\n'
        + '<< /Type /Catalog /Pages 2 0 R >>\n'
        + 'endobj\n'
        + '2 0 obj\n'
        + '<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n'
        + 'endobj\n'
        + '3 0 obj\n'
        + '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>\n'
        + 'endobj\n'
        + '4 0 obj\n'
        + '<< /Length 0 >>\n'
        + 'stream\n'
        + '\n'
        + 'endstream\n'
        + 'endobj\n',
    ));
    const tailBegin = PDF_SIZE - MEGABYTE;
    const tail = new Uint8Array(MEGABYTE);
    tail.set(encoder.encode(
        'trailer\n'
        + '<< /Root 1 0 R /Size 5 >>\n'
        + 'startxref\n'
        + '0\n'
        + '%%EOF\n',
    ));

    return {
        initialData: prefix,
        readRange(begin: number, length: number) {
            const bytes = new Uint8Array(length);
            copyOverlap(bytes, begin, prefix, 0);
            copyOverlap(bytes, begin, tail, tailBegin);
            return bytes;
        },
    };
}

function createValidSparsePdf() {
    const encoder = new TextEncoder();
    const prefixText = '%PDF-1.7\n'
        + '9 0 obj\n'
        + '<< /Type /NotLinearized >>\n'
        + 'endobj\n'
        + '10 0 obj\n'
        + '<< /Type /NotLinearized >>\n'
        + 'endobj\n';
    const objectText = '1 0 obj\n'
        + '<< /Type /Catalog /Pages 2 0 R >>\n'
        + 'endobj\n'
        + '2 0 obj\n'
        + '<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n'
        + 'endobj\n'
        + '3 0 obj\n'
        + '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\n'
        + 'endobj\n';
    const prefix = new Uint8Array(MEGABYTE);
    prefix.set(encoder.encode(prefixText));
    const objectBytes = encoder.encode(objectText);
    const tailBegin = LARGE_PDF_SIZE - MEGABYTE;
    const objectOffsets = [
        0,
        tailBegin + objectText.indexOf('1 0 obj'),
        tailBegin + objectText.indexOf('2 0 obj'),
        tailBegin + objectText.indexOf('3 0 obj'),
    ];
    const tailXrefOffset = MEGABYTE - 1024;
    const xrefBegin = LARGE_PDF_SIZE - 1024;
    const xref = [
        'xref',
        '0 4',
        '0000000000 65535 f ',
        ...objectOffsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
        'trailer',
        '<< /Root 1 0 R /Size 4 /ID [<0123456789abcdef><0123456789abcdef>] >>',
        'startxref',
        String(xrefBegin),
        '%%EOF',
        '',
    ].join('\n');
    const tail = new Uint8Array(MEGABYTE);
    tail.set(objectBytes);
    tail.set(encoder.encode(xref), tailXrefOffset);

    return {
        initialData: prefix,
        readRange(begin: number, length: number) {
            const bytes = new Uint8Array(length);
            copyOverlap(bytes, begin, prefix, 0);
            copyOverlap(bytes, begin, tail, tailBegin);
            return bytes;
        },
    };
}

async function createPdfjsWorker() {
    const workerUrl = pathToFileURL(resolve(
        process.cwd(),
        'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    )).href;
    const workerSource = `
        const {parentPort} = require('node:worker_threads');
        (async () => {
            const {WorkerMessageHandler} = await import(${JSON.stringify(workerUrl)});
            const port = {
                postMessage(message, transfer) {
                    parentPort.postMessage(message, transfer);
                },
                addEventListener(type, listener) {
                    parentPort.on(type, data => listener({data}));
                },
                removeEventListener() {},
            };
            WorkerMessageHandler.initializeFromPort(port);
        })();
    `;
    const nodeWorker = new Worker(workerSource, {eval: true});
    type TNodeWorkerListener = (data: unknown) => void;
    type TMessageListener = (event: {data: unknown}) => void;
    const listeners = new Map<TMessageListener, TNodeWorkerListener>();
    const port = {
        postMessage(message: unknown, transfer?: ArrayBuffer[]) {
            if (transfer) {
                nodeWorker.postMessage(message, transfer);
            } else {
                nodeWorker.postMessage(message);
            }
        },
        addEventListener(_type: 'message', listener: TMessageListener) {
            const wrapped: TNodeWorkerListener = data => listener({data});
            listeners.set(listener, wrapped);
            nodeWorker.on('message', wrapped);
        },
        removeEventListener(_type: 'message', listener: TMessageListener) {
            const wrapped = listeners.get(listener);
            if (wrapped) {
                nodeWorker.off('message', wrapped);
                listeners.delete(listener);
            }
        },
    };
    // pdfjs-dist's declaration only permits a null port, but its runtime worker bridge accepts this port.
    const pdfWorker = Reflect.construct(PDFWorker, [{port}]) as InstanceType<typeof PDFWorker>;
    await pdfWorker.promise;
    return {
        close: async () => {
            pdfWorker.destroy();
            await nodeWorker.terminate();
        },
        pdfWorker,
    };
}

describe('PDF.js range transport', () => {
    it('recovers a malformed-xref 17 MiB source with bounded range reads', async () => {
        const source = createMalformedSparsePdf();
        const requests: IRangeRequest[] = [];
        const deliveries: Array<{
            begin: number;
            isLast?: boolean
        }> = [];
        const worker = await createPdfjsWorker();
        let document: Awaited<ReturnType<typeof getDocument>['promise']> | undefined;

        class SparseRangeTransport extends PDFDataRangeTransport {
            constructor() {
                super(PDF_SIZE, source.initialData, false);
            }

            override onDataRange(begin: number, chunk: Uint8Array | null, isLast?: boolean) {
                if (!chunk) {
                    throw new Error('PDF.js requested an empty range');
                }
                deliveries.push({
                    begin,
                    ...(isLast === undefined ? {} : {isLast}),
                });
                // pdfjs-dist's declaration omits the optional runtime third argument.
                Reflect.apply(super.onDataRange, this, [
                    begin,
                    chunk,
                    isLast,
                ]);
            }

            override requestDataRange(begin: number, end: number) {
                requests.push({
                    begin,
                    end,
                });
                queueMicrotask(() => {
                    for (let offset = begin; offset < end; offset += MEGABYTE) {
                        const chunkEnd = Math.min(end, offset + MEGABYTE);
                        const isLast = chunkEnd === end;
                        this.onDataRange(
                            begin,
                            source.readRange(offset, chunkEnd - offset),
                            isLast ? undefined : false,
                        );
                    }
                });
            }
        }

        const transport = new SparseRangeTransport();
        try {
            document = await getDocument({
                disableAutoFetch: true,
                disableStream: true,
                length: PDF_SIZE,
                range: transport,
                rangeChunkSize: MEGABYTE,
                worker: worker.pdfWorker,
            }).promise;

            expect(document.numPages).toBe(1);
            expect(requests.length).toBeGreaterThan(0);
            expect(requests.every(({
                begin,
                end,
            }) => end - begin <= MEGABYTE)).toBe(true);
            expect(requests.some(({begin}) => begin >= PDF_SIZE - MEGABYTE)).toBe(true);
            expect(deliveries.at(-1)?.isLast).toBeUndefined();
        } finally {
            await document?.destroy();
            await worker.close();
        }
    });

    it('rejects whole-document data and save messages before a 2 GiB range source can materialize', async () => {
        const source = createValidSparsePdf();
        const requestedLengths: number[] = [];
        const worker = await createPdfjsWorker();
        let document: Awaited<ReturnType<typeof getDocument>['promise']> | undefined;

        class SparseRangeTransport extends PDFDataRangeTransport {
            constructor() {
                super(LARGE_PDF_SIZE, new Uint8Array(0), false);
            }

            override onDataRange(begin: number, chunk: Uint8Array | null, isLast?: boolean) {
                // pdfjs-dist's declaration omits the optional runtime third argument.
                Reflect.apply(super.onDataRange, this, [
                    begin,
                    chunk,
                    isLast,
                ]);
            }

            override requestDataRange(begin: number, end: number) {
                requestedLengths.push(end - begin);
                queueMicrotask(() => {
                    for (let offset = begin; offset < end; offset += MEGABYTE) {
                        const chunkEnd = Math.min(end, offset + MEGABYTE);
                        const isLast = chunkEnd === end;
                        this.onDataRange(
                            begin,
                            source.readRange(offset, chunkEnd - offset),
                            isLast ? undefined : false,
                        );
                    }
                });
            }
        }

        const transport = new SparseRangeTransport();
        try {
            document = await getDocument({
                disableAutoFetch: true,
                disableStream: true,
                length: LARGE_PDF_SIZE,
                range: transport,
                rangeChunkSize: MEGABYTE,
                worker: worker.pdfWorker,
            }).promise;

            expect(document.numPages).toBe(1);
            const requestCountBeforeMaterialization = requestedLengths.length;
            await expect(document.getData()).rejects.toMatchObject({
                name: 'UnknownErrorException',
                details: {
                    code: 'native-save-required',
                    operation: 'GetData',
                },
            });
            await expect(document.saveDocument()).rejects.toMatchObject({
                name: 'UnknownErrorException',
                details: {
                    code: 'native-save-required',
                    operation: 'SaveDocument',
                },
            });
            expect(requestedLengths.slice(requestCountBeforeMaterialization))
                .toEqual([]);
            expect(requestedLengths.every(length => length <= MEGABYTE)).toBe(true);
        } finally {
            await document?.destroy();
            await worker.close();
        }
    });
});
