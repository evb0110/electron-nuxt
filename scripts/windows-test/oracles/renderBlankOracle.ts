import { createCanvas } from '@napi-rs/canvas';
import type { IOracleResult } from '@scripts/windows-test/oracles/oracleResult';
import {
    createOracleResult,
    describeError,
} from '@scripts/windows-test/oracles/oracleResult';
import {
    isPdfjsRuntimeUnavailable,
    loadPdfjsDocument,
} from '@scripts/windows-test/oracles/pdfjsNodeRuntime';

export const RENDER_BLANK_ORACLE_ID = 'render-nonblank';

export const RENDER_BLANK_ORACLE_VERSION = 'pdfjs-dist@5.7+napi-canvas';

export const RENDER_MASK_COLUMNS = 24;

export const RENDER_MASK_ROWS = 32;

const INK_LUMINANCE_CEILING = 245;

export interface IRenderedPageObservation {
    pageNumber: number;
    width: number;
    height: number;
    nonWhiteRatio: number;
    meanLuminance: number;
    inkCells: number;
    contentMask: number[];
}

export interface IRenderBlankExpectation {
    repositoryRoot: string;
    minNonWhiteRatio?: number;
    minInkCells?: number;
    scale?: number;
    referenceContentMasks?: ReadonlyArray<readonly number[]>;
    maxMaskDivergence?: number;
}

function castRenderSurface<T>(value: object) {
    // @napi-rs/canvas implements the parts of the DOM canvas surface PDF.js
    // touches, but it does not declare the DOM types, so the render call needs
    // the structural handoff.
    return value as T;
}

export async function renderPageObservations(
    bytes: Uint8Array,
    expectation: IRenderBlankExpectation,
): Promise<IRenderedPageObservation[]> {
    const scale = expectation.scale ?? 1;
    const document = await loadPdfjsDocument(bytes, { repositoryRoot: expectation.repositoryRoot });
    try {
        const observations: IRenderedPageObservation[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const viewport = page.getViewport({ scale });
            const width = Math.max(1, Math.ceil(viewport.width));
            const height = Math.max(1, Math.ceil(viewport.height));
            const canvas = createCanvas(width, height);
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, width, height);
            await page.render({
                canvas: castRenderSurface<HTMLCanvasElement>(canvas),
                canvasContext: castRenderSurface<CanvasRenderingContext2D>(context),
                viewport,
            }).promise;
            const pixels = context.getImageData(0, 0, width, height).data;
            const cellInk = new Array<number>(RENDER_MASK_COLUMNS * RENDER_MASK_ROWS).fill(0);
            let inkPixels = 0;
            let luminanceTotal = 0;
            for (let offset = 0; offset < pixels.length; offset += 4) {
                const luminance = ((pixels[offset] ?? 255) * 0.2126)
                    + ((pixels[offset + 1] ?? 255) * 0.7152)
                    + ((pixels[offset + 2] ?? 255) * 0.0722);
                luminanceTotal += luminance;
                if (luminance >= INK_LUMINANCE_CEILING) {
                    continue;
                }
                inkPixels += 1;
                const pixelIndex = offset / 4;
                const column = Math.min(
                    RENDER_MASK_COLUMNS - 1,
                    Math.floor(((pixelIndex % width) / width) * RENDER_MASK_COLUMNS),
                );
                const row = Math.min(
                    RENDER_MASK_ROWS - 1,
                    Math.floor((Math.floor(pixelIndex / width) / height) * RENDER_MASK_ROWS),
                );
                const cellIndex = (row * RENDER_MASK_COLUMNS) + column;
                cellInk[cellIndex] = (cellInk[cellIndex] ?? 0) + 1;
            }
            const pixelCount = width * height;
            observations.push({
                pageNumber,
                width,
                height,
                nonWhiteRatio: inkPixels / pixelCount,
                meanLuminance: luminanceTotal / pixelCount,
                inkCells: cellInk.filter(value => value > 0).length,
                contentMask: cellInk.map(value => (value > 0 ? 1 : 0)),
            });
            page.cleanup();
        }
        return observations;
    } finally {
        await document.destroy();
    }
}

function compareMasks(actual: readonly number[], reference: readonly number[]) {
    const length = Math.max(actual.length, reference.length);
    let divergent = 0;
    for (let index = 0; index < length; index += 1) {
        if ((actual[index] ?? 0) !== (reference[index] ?? 0)) {
            divergent += 1;
        }
    }
    return length === 0 ? 0 : divergent / length;
}

export async function evaluateRenderNonBlank(
    bytes: Uint8Array,
    expectation: IRenderBlankExpectation,
): Promise<IOracleResult> {
    let observations: IRenderedPageObservation[];
    try {
        observations = await renderPageObservations(bytes, expectation);
    } catch (error) {
        return createOracleResult({
            oracleId: RENDER_BLANK_ORACLE_ID,
            oracleVersion: RENDER_BLANK_ORACLE_VERSION,
            status: isPdfjsRuntimeUnavailable(error) ? 'inconclusive' : 'failed',
            detail: `Rendering failed: ${describeError(error)}`,
            observations: { bytes: bytes.byteLength },
        });
    }
    if (observations.length === 0) {
        return createOracleResult({
            oracleId: RENDER_BLANK_ORACLE_ID,
            oracleVersion: RENDER_BLANK_ORACLE_VERSION,
            status: 'failed',
            detail: 'The document rendered zero pages.',
            observations: {},
        });
    }
    const minNonWhiteRatio = expectation.minNonWhiteRatio ?? 0.002;
    const minInkCells = expectation.minInkCells ?? 4;
    const maxMaskDivergence = expectation.maxMaskDivergence ?? 0;
    const failures: string[] = [];
    for (const observation of observations) {
        if (observation.nonWhiteRatio < minNonWhiteRatio) {
            failures.push(
                `page ${observation.pageNumber} has a non-white ratio of ${observation.nonWhiteRatio.toFixed(5)}, below ${minNonWhiteRatio}`,
            );
        }
        if (observation.inkCells < minInkCells) {
            failures.push(
                `page ${observation.pageNumber} covers ${observation.inkCells} content cells, below ${minInkCells}`,
            );
        }
    }
    const references = expectation.referenceContentMasks;
    if (references !== undefined) {
        if (references.length !== observations.length) {
            failures.push(
                `reference mask list covers ${references.length} pages but ${observations.length} were rendered`,
            );
        }
        observations.forEach((observation, index) => {
            const reference = references[index];
            if (reference === undefined) {
                return;
            }
            const divergence = compareMasks(observation.contentMask, reference);
            if (divergence > maxMaskDivergence) {
                failures.push(
                    `page ${observation.pageNumber} content mask diverges from the reference by ${divergence.toFixed(4)}, above ${maxMaskDivergence}`,
                );
            }
        });
    }
    return createOracleResult({
        oracleId: RENDER_BLANK_ORACLE_ID,
        oracleVersion: RENDER_BLANK_ORACLE_VERSION,
        status: failures.length === 0 ? 'passed' : 'failed',
        detail: failures.length === 0
            ? `All ${observations.length} pages carry content above the blankness floor.`
            : failures.join('; '),
        observations: { pages: observations },
    });
}
