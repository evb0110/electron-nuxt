import type { PDFDataRangeTransport } from 'pdfjs-dist';
import type { TPdfSource } from '@app/types/pdfUi';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import { isLargeSerializedSaveAllowedForAutomation } from '@app/utils/isLargeSerializedSaveAllowedForAutomation';

const PDF_RANGE_SUBREAD_BYTES = 8 * 1024 * 1024;
const MAX_AGGREGATE_PDF_RANGE_BYTES = 64 * 1024 * 1024;
const MAX_QUEUED_PDF_RANGE_REQUESTS = 32;

export interface IPdfPreloadedRange {
    begin: number;
    data: Uint8Array;
}

interface IPdfRangeRequestBridgeOptions {
    getRenderVersion: () => number;
    onRangeReadFailure: (error: unknown, version: number) => void;
}

export function createPdfRangeRequestBridge({
    getRenderVersion,
    onRangeReadFailure,
}: IPdfRangeRequestBridgeOptions) {
    let rangeReadTail = Promise.resolve();
    let queuedRangeReads = 0;
    function createRangeReadFailureHandler() {
        let rejectRangeReadFailure: ((error: Error) => void) | null = null;
        const rangeReadFailure = new Promise<never>((_resolve, reject) => {
            rejectRangeReadFailure = reject;
        });

        const failRangeRead = (error: unknown) => {
            if (!rejectRangeReadFailure) {
                return;
            }

            const reject = rejectRangeReadFailure;
            rejectRangeReadFailure = null;
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        return {
            rangeReadFailure,
            failRangeRead,
            complete: () => {
                rejectRangeReadFailure = null;
            },
        };
    }

    /**
     * Fulfill the exact byte interval requested by PDF.js range transport.
     *
     * The platform read capability is chunk-budgeted and may legally return
     * fewer bytes than requested. PDF.js creates one range reader for the
     * original `[begin, end)` interval, so the bridge must aggregate any
     * subreads and call `onDataRange(begin, fullChunk)` exactly once. Delivering
     * only the first short chunk leaves the worker waiting forever; delivering
     * later chunks separately throws because there is no reader for their
     * shifted offset. The Girgas page 928 repro hit this when PDF.js requested
     * about 10 MB and Electron capped the read to 8 MB.
     */
    async function fulfillPdfRangeRequest(
        transport: PDFDataRangeTransport,
        src: Extract<TPdfSource, { kind: 'path' }>,
        begin: number,
        end: number,
        version: number,
        preloadedRanges: readonly IPdfPreloadedRange[],
    ) {
        const totalLength = end - begin;
        if (!Number.isSafeInteger(totalLength) || totalLength <= 0) {
            throw new Error(`Invalid PDF range request ${begin}..${end}`);
        }
        if (
            totalLength > MAX_AGGREGATE_PDF_RANGE_BYTES
            && !isLargeSerializedSaveAllowedForAutomation()
        ) {
            throw new Error(`PDF range request ${begin}..${end} exceeds ${MAX_AGGREGATE_PDF_RANGE_BYTES} byte limit`);
        }
        if (version !== getRenderVersion()) {
            return;
        }

        const preloadedRange = preloadedRanges.find((range) => {
            const relativeBegin = begin - range.begin;
            const relativeEnd = end - range.begin;
            return relativeBegin >= 0
                && relativeEnd <= range.data.byteLength;
        });
        if (preloadedRange) {
            const relativeBegin = begin - preloadedRange.begin;
            const relativeEnd = end - preloadedRange.begin;
            const output = preloadedRange.data.slice(relativeBegin, relativeEnd);
            transport.onDataRange(begin, output);
            logPdfRenderTrace('pdf-document-range-fulfilled-from-cache', {
                begin,
                end,
                byteLength: output.byteLength,
                version,
            });
            return;
        }

        const documentFiles = getDocumentFilesCapability();
        let cursor = begin;
        let outputOffset = 0;
        let output: Uint8Array | null = null;
        while (cursor < end) {
            if (version !== getRenderVersion()) {
                logPdfRenderTrace('pdf-document-range-request-stale-before-read', {
                    begin,
                    end,
                    cursor,
                    version,
                    renderVersion: getRenderVersion(),
                });
                return;
            }

            const requestedLength = Math.min(PDF_RANGE_SUBREAD_BYTES, end - cursor);
            const chunk = await documentFiles.readFileRange(src.path, cursor, requestedLength);
            if (version !== getRenderVersion()) {
                logPdfRenderTrace('pdf-document-range-request-stale-after-read', {
                    begin,
                    end,
                    cursor,
                    version,
                    renderVersion: getRenderVersion(),
                });
                return;
            }
            if (chunk.byteLength === 0) {
                throw new Error(`Range read returned no bytes at ${cursor} before requested end ${end}`);
            }

            if (cursor === begin && chunk.byteLength === totalLength) {
                transport.onDataRange(begin, chunk);
                logPdfRenderTrace('pdf-document-range-fulfilled-direct', {
                    begin,
                    end,
                    byteLength: chunk.byteLength,
                    version,
                });
                return;
            }

            output ??= new Uint8Array(totalLength);
            if (chunk.byteLength > output.byteLength - outputOffset) {
                throw new Error(`Range read returned ${chunk.byteLength} bytes for ${output.byteLength - outputOffset} remaining bytes`);
            }

            output.set(chunk, outputOffset);
            logPdfRenderTrace('pdf-document-range-subread', {
                begin: cursor,
                end: cursor + chunk.byteLength,
                requestedEnd: end,
                byteLength: chunk.byteLength,
                requestedLength,
                version,
            });
            outputOffset += chunk.byteLength;
            cursor += chunk.byteLength;
        }

        if (!output) {
            throw new Error(`Range read produced no output for ${begin}..${end}`);
        }
        transport.onDataRange(begin, output);
        logPdfRenderTrace('pdf-document-range-fulfilled', {
            begin,
            end,
            byteLength: output.byteLength,
            version,
        });
    }

    function attachRangeRequestHandler(
        transport: PDFDataRangeTransport,
        src: Extract<TPdfSource, { kind: 'path' }>,
        version: number,
        failRangeRead: (error: unknown) => void,
        preloadedRanges: readonly IPdfPreloadedRange[],
    ) {
        // PDF.js will call this to request additional chunks.
        transport.requestDataRange = (
            begin,
            end: number,
        ) => {
            void (async () => {
                logPdfRenderTrace('pdf-document-range-request', {
                    begin,
                    end,
                    length: end - begin,
                    version,
                });
                if (queuedRangeReads >= MAX_QUEUED_PDF_RANGE_REQUESTS) {
                    const error = new Error('PDF range request queue is full');
                    failRangeRead(error);
                    onRangeReadFailure(error, version);
                    return;
                }
                queuedRangeReads += 1;
                const predecessor = rangeReadTail;
                let releaseQueueSlot!: () => void;
                rangeReadTail = new Promise<void>((resolve) => {
                    releaseQueueSlot = resolve;
                });
                try {
                    await predecessor;
                    await fulfillPdfRangeRequest(
                        transport,
                        src,
                        begin,
                        end,
                        version,
                        preloadedRanges,
                    );
                } catch (error) {
                    if (version !== getRenderVersion()) {
                        return;
                    }

                    logPdfRenderTrace('pdf-document-range-error', {
                        begin,
                        end,
                        version,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    BrowserLogger.error(
                        'pdf-document',
                        'Failed to read PDF range chunk',
                        error,
                    );
                    failRangeRead(error);
                    onRangeReadFailure(error, version);
                } finally {
                    queuedRangeReads -= 1;
                    releaseQueueSlot();
                }
            })();
        };
    }

    return {
        createRangeReadFailureHandler,
        attachRangeRequestHandler,
    };
}
