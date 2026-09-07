import { spawn } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
import { AVAILABLE_OCR_LANGUAGES } from '@contracts/ocrLanguages';
import type { IOracleResult } from '@scripts/windows-test/oracles/oracleResult';
import {
    createOracleResult,
    describeError,
} from '@scripts/windows-test/oracles/oracleResult';
import {
    isPdfjsRuntimeUnavailable,
    loadPdfjsDocument,
} from '@scripts/windows-test/oracles/pdfjsNodeRuntime';
import {collectMarkerFailures} from '@scripts/windows-test/oracles/collectMarkerFailures';
import {withRenderedPdfPage} from '@scripts/windows-test/oracles/withRenderedPdfPage';

const OCR_PAGE_MARKER_LANGUAGE_CODE = (() => {
    const language = AVAILABLE_OCR_LANGUAGES.find(language => language.code === 'eng');
    if (language === undefined) {
        throw new Error('The OCR language registry must contain the eng model used by the page-marker oracle.');
    }
    return language.code;
})();

export const OCR_PAGE_MARKER_ORACLE_VERSION = `pdfjs-dist@6.3.311+napi-canvas+tesseract-${OCR_PAGE_MARKER_LANGUAGE_CODE}`;

export const DEFAULT_TESSERACT_PATH = 'tesseract';

const OCR_RENDER_SCALE = 8;
const OCR_PROCESS_TIMEOUT_MS = 30_000;
const OCR_MARKER_WHITELIST = 'EVB-F0123456789PAGE';

export interface IOcrProcessResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export type TOcrProcessRunner = (
    command: string,
    args: readonly string[],
    input: Uint8Array,
    timeoutMs: number,
) => Promise<IOcrProcessResult>;

export interface IOcrPageMarkerExpectation {
    repositoryRoot: string;
    expectedMarkers: readonly string[];
    forbiddenMarkers?: readonly string[];
    tesseractPath?: string;
    processRunner?: TOcrProcessRunner;
}

interface IOcrPageMarkerObservation {
    pageNumber: number;
    text: string;
}

export class OcrRuntimeUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OcrRuntimeUnavailableError';
    }
}

class OcrProcessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OcrProcessError';
    }
}

function appendOutput(current: string, chunk: Buffer) {
    const next = current + chunk.toString('utf8');
    return next.length > 256 * 1024 ? next.slice(0, 256 * 1024) : next;
}

const defaultProcessRunner: TOcrProcessRunner = (command, args, input, timeoutMs) => new Promise((resolve, reject) => {
    let child;
    try {
        child = spawn(command, [...args], {stdio: [
            'pipe',
            'pipe',
            'pipe',
        ]});
    } catch (error) {
        reject(new OcrRuntimeUnavailableError(`Could not start OCR command ${command}: ${describeError(error)}.`));
        return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
            child.kill('SIGKILL');
        }, 1_000);
    }, timeoutMs);
    const finish = (result: IOcrProcessResult) => {
        if (settled) {
            return;
        }
        settled = true;
        clearTimeout(timer);
        if (killTimer !== undefined) {
            clearTimeout(killTimer);
        }
        resolve(result);
    };
    child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
        stderr = appendOutput(stderr, chunk);
    });
    child.on('error', error => {
        if (settled) {
            return;
        }
        settled = true;
        clearTimeout(timer);
        if (killTimer !== undefined) {
            clearTimeout(killTimer);
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            reject(new OcrRuntimeUnavailableError(`OCR command ${command} is unavailable.`));
            return;
        }
        reject(new OcrProcessError(`OCR command ${command} failed to start: ${describeError(error)}.`));
    });
    child.on('close', (exitCode, signal) => {
        finish({
            exitCode: typeof exitCode === 'number' ? exitCode : null,
            stdout,
            stderr: signal === null ? stderr : `${stderr}\nProcess ended with ${signal}.`,
            timedOut,
        });
    });
    child.stdin.on('error', error => {
        if ((error as NodeJS.ErrnoException).code !== 'EPIPE' && !settled) {
            child.kill('SIGTERM');
        }
    });
    child.stdin.end(Buffer.from(input));
});

function markerCrop(width: number, height: number) {
    const x = Math.max(0, Math.floor(width * 0.08));
    const y = Math.max(0, Math.floor(height * 0.10));
    const cropWidth = Math.max(1, Math.floor(width * 0.60));
    const cropHeight = Math.max(1, Math.floor(height * 0.10));
    return {
        x,
        y,
        width: Math.min(cropWidth, width - x),
        height: Math.min(cropHeight, height - y),
    };
}

function readOcrText(stdout: string) {
    return stdout
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join(' ');
}

async function renderMarkerCrop(page: unknown) {
    return withRenderedPdfPage(page, OCR_RENDER_SCALE, ({
        context,
        width,
        height,
    }) => {
        const crop = markerCrop(width, height);
        const cropCanvas = createCanvas(crop.width, crop.height);
        const cropContext = cropCanvas.getContext('2d');
        cropContext.putImageData(
            context.getImageData(crop.x, crop.y, crop.width, crop.height),
            0,
            0,
        );
        return cropCanvas.toBuffer('image/png');
    });
}

export async function extractOcrPageMarkers(
    bytes: Uint8Array,
    expectation: IOcrPageMarkerExpectation,
): Promise<IOcrPageMarkerObservation[]> {
    const document = await loadPdfjsDocument(bytes, {repositoryRoot: expectation.repositoryRoot});
    const processRunner = expectation.processRunner ?? defaultProcessRunner;
    const tesseractPath = expectation.tesseractPath ?? DEFAULT_TESSERACT_PATH;
    try {
        const observations: IOcrPageMarkerObservation[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            try {
                const image = await renderMarkerCrop(page);
                const result = await processRunner(
                    tesseractPath,
                    [
                        'stdin',
                        'stdout',
                        '-l',
                        OCR_PAGE_MARKER_LANGUAGE_CODE,
                        '--psm',
                        '6',
                        '-c',
                        `tessedit_char_whitelist=${OCR_MARKER_WHITELIST}`,
                    ],
                    image,
                    OCR_PROCESS_TIMEOUT_MS,
                );
                if (result.timedOut || result.exitCode !== 0) {
                    throw new OcrProcessError(
                        `OCR command ${tesseractPath} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
                    );
                }
                observations.push({
                    pageNumber,
                    text: readOcrText(result.stdout),
                });
            } finally {
                page.cleanup();
            }
        }
        return observations;
    } finally {
        await document.destroy();
    }
}

export async function evaluateOcrPageMarkers(
    bytes: Uint8Array,
    expectation: IOcrPageMarkerExpectation,
): Promise<IOracleResult> {
    let observations: IOcrPageMarkerObservation[];
    try {
        observations = await extractOcrPageMarkers(bytes, expectation);
    } catch (error) {
        return createOracleResult({
            oracleId: 'page-markers',
            oracleVersion: OCR_PAGE_MARKER_ORACLE_VERSION,
            status: isPdfjsRuntimeUnavailable(error) || error instanceof OcrRuntimeUnavailableError || error instanceof OcrProcessError
                ? 'inconclusive'
                : 'failed',
            detail: `OCR marker extraction failed: ${describeError(error)}`,
            observations: {bytes: bytes.byteLength},
        });
    }
    const failures = collectMarkerFailures(
        observations,
        expectation.expectedMarkers,
        expectation.forbiddenMarkers,
        (marker, observation, index) => observation.text === marker
            ? undefined
            : `page ${index + 1} OCR marker ${JSON.stringify(observation.text)} does not exactly match ${marker}`,
    );
    return createOracleResult({
        oracleId: 'page-markers',
        oracleVersion: OCR_PAGE_MARKER_ORACLE_VERSION,
        status: failures.length === 0 ? 'passed' : 'failed',
        detail: failures.length === 0
            ? `OCR found all ${expectation.expectedMarkers.length} exact markers on their expected pages in order.`
            : failures.join('; '),
        observations: {pages: observations},
    });
}
