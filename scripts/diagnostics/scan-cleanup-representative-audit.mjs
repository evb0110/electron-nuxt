#!/usr/bin/env node
// Oracle audit for scan-cleanup representative fixtures. Renders source and
// cleaned PDFs to low-DPI grayscale PGM with pdftoppm and infers the source to
// output mapping from the rendered output count and page evidence. It checks
// that mapped content survived: no page dropped, no ink invented on a blank
// verso, no content erased, no page squeezed instead of split. This is a
// coarse pixel-grid oracle (~50 DPI), not a replacement for the finer
// word-loss audit.

import {execFile} from 'node:child_process';
import {
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {tsImport} from 'tsx/esm/api';
import {
    buildExpectationInfos as buildExpectationInfosImpl,
    buildSpreadLeafAlignment,
    contentBboxHeightFraction,
    measureSpreadLeafVerticalAlignment as measureSpreadLeafVerticalAlignmentImpl,
} from './scan-cleanup-representative-audit-leaf-alignment.mjs';

export {buildExpectationInfosImpl as buildExpectationInfos};

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const {resolveCliNativeToolPath} = await tsImport('../scanCleanupCliAdapters.ts', import.meta.url);

// Both pdfinfo and pdftoppm ship in the poppler native resource bundle; see
// scan-cleanup-word-loss-audit.mjs for the same resolution pattern.
const AUDIT_TOOL_CRATES = {
    pdfinfo: 'poppler',
    pdftoppm: 'poppler',
};
const auditToolPaths = new Map();
function resolveAuditTool(command) {
    let resolved = auditToolPaths.get(command);
    if (resolved === undefined) {
        resolved = resolveCliNativeToolPath(command, AUDIT_TOOL_CRATES[command], projectRoot) ?? command;
        auditToolPaths.set(command, resolved);
    }
    return resolved;
}

async function run(command, args) {
    try {
        const {stdout} = await execFileAsync(resolveAuditTool(command), args, {
            cwd: projectRoot,
            maxBuffer: 64 * 1024 * 1024,
        });
        return stdout;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
    }
}

// Render resolution: low DPI keeps rendering + grid math cheap given how
// coarse the grids below are.
const DEFAULT_DPI = 50;
// Per-pixel darkness threshold on the 0-255 grayscale sample.
const INK_THRESHOLD = 128;
// Coarse grid for ink-fraction/similarity. Min-pooling (darkest sample wins
// per cell) preserves thin strokes that average-pooling would dilute away.
const COARSE_COLS = 20;
const COARSE_ROWS = 28;
// A denser grid is used to reject isolated specks, scanner rails, and pale
// ghosting before a source page is treated as carrying content. The layout
// grid intentionally remains separate: pale but genuinely bilateral spreads
// still need to be recognized as spreads for page-count auditing.
const STRUCTURE_COLS = 80;
const STRUCTURE_ROWS = 112;
const STRUCTURED_INK_THRESHOLD = 112;
const MIN_STRUCTURED_COMPONENT_CELLS = 4;
const STRUCTURE_INTERIOR_MARGIN_CELLS = 3;
const EDGE_RESIDUE_MAX_THICKNESS_CELLS = 3;
const EDGE_RESIDUE_MIN_SPAN_FRACTION = 0.65;
const STRUCTURED_CONTENT_INK_FRACTION = 0.01;
const STRUCTURED_BLANK_INK_FRACTION = 0.005;
const STRUCTURED_BLANK_MAX_CLEANED_INK_FRACTION = 0.004;
const STRUCTURED_EDGE_ARTIFACT_MIN_FRACTION = 0.002;
const BLANK_INK_FRACTION = 0.005;
const FULL_PAGE_FIELD_MIN_FRACTION = 0.2;
const SEMANTIC_FULL_PAGE_FIELD_MIN_FRACTION = 0.5;
const EDGE_GEOMETRY_MIN_FRACTION = 0.02;
const EDGE_STRUCTURE_STRIP_CELLS = 4;
const MIN_EDGE_STRUCTURE_CELLS = 16;
const MIN_EDGE_STRUCTURE_SPAN_FRACTION = 0.35;
const LAYOUT_MIN_ASPECT_RATIO = 1.15;
const LAYOUT_MIN_HALF_INK_FRACTION = 0.04;
const CONTENT_MIN_RETENTION = 0.4;
// Below SIMILARITY_MIN_INK_FRACTION a page is sparse enough (pale front
// matter, running heads) that a small deskew/crop shift moves content across
// grid-cell boundaries and tanks the Jaccard score with no real content loss
// -- observed on the fixture's front-matter pages (ink ~0.13-0.20, similarity
// 0.09-0.13, retention 77-107%). Below the cutoff, rely on retention alone;
// above it, healthy pages hold a wide margin over genuine misalignment
// (observed floor ~0.24 vs. ~0.10 on pages cascaded by the unsplit spread).
const SIMILARITY_MIN_INK_FRACTION = 0.35;
const CONTENT_MIN_SIMILARITY = 0.2;
const ALIGNMENT_MAX_TRANSLATION_FRACTION = 0.15;
const ALIGNMENT_MIN_OVERLAP = CONTENT_MIN_SIMILARITY;
const ALIGNMENT_MIN_SIMILARITY = CONTENT_MIN_SIMILARITY;
// The cleaned page's content bounding-box height (as a fraction of page
// height) must be at least this fraction of the source half's, or the page
// was squeezed into part of the canvas instead of filling it.
const GEOMETRY_MIN_HEIGHT_RATIO = 0.6;
const GEOMETRY_INTERIOR_MARGIN_CELLS = 2;
// A short source content island is not a reliable page-height reference. This
// is deliberately above a one-third-page island so sparse front matter and
// bleed-through do not turn a valid crop into a squeeze violation.
const GEOMETRY_MIN_SOURCE_BBOX_HEIGHT_FRACTION = 0.4;

function parseArgs(argv) {
    const options = {
        cleaned: null,
        dpi: DEFAULT_DPI,
        expectSingles: new Set(),
        out: null,
        source: null,
    };
    const valueArguments = new Set([
        '--cleaned',
        '--dpi',
        '--expect-singles',
        '--out',
        '--source',
    ]);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') {
            printHelp();
            return {
                ...options,
                help: true,
            };
        }
        if (!valueArguments.has(argument)) {
            throw new Error(`Unknown argument: ${argument}`);
        }
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`Missing value for ${argument}`);
        }
        if (argument === '--source' || argument === '--cleaned') {
            options[argument.slice(2)] = resolve(value);
        } else if (argument === '--out') {
            options.out = resolve(value);
        } else if (argument === '--dpi') {
            options.dpi = parsePositiveInteger(value, argument);
        } else if (argument === '--expect-singles') {
            options.expectSingles = parsePageList(value);
        }
        index += 1;
    }
    if (!options.source || !options.cleaned || !options.out) {
        throw new Error('--source, --cleaned, and --out are all required');
    }
    return options;
}

function printHelp() {
    console.log(`Usage: node scripts/diagnostics/scan-cleanup-representative-audit.mjs --source <fixture.pdf> --cleaned <output.pdf> --out <report.json> [options]

Checks that inferred source-to-output regions survived the scan-cleanup
pipeline: page count conserved, no ink invented on blank versos, no content
erased, no page squeezed instead of split.

Options:
  --source <pdf>          Source (pre-pipeline) PDF, e.g. the representative fixture
  --cleaned <pdf>          Pipeline output PDF to audit
  --out <json>             Report path (required)
  --expect-singles <list>  Legacy manifest hint: listed pages are singles and
                            omitted pages are spreads; mismatches are INFO only
                            (mapping is inferred from rendered source/output)
  --dpi <n>                Render resolution for the audit (default: ${DEFAULT_DPI})
  --help                   Show this message

Exit code: 0 when no violations were found, 1 otherwise.`);
}

function parsePositiveInteger(value, argument) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${argument} must be a positive integer`);
    }
    return parsed;
}

function parsePageList(value) {
    const pages = new Set();
    for (const token of value.split(',')) {
        const trimmed = token.trim();
        if (trimmed !== '') {
            pages.add(parsePositiveInteger(trimmed, '--expect-singles'));
        }
    }
    return pages;
}

async function getPdfPageCount(pdfPath) {
    const stdout = await run('pdfinfo', [pdfPath]);
    const match = /^Pages:\s+(\d+)$/mu.exec(stdout);
    if (!match) {
        throw new Error(`Could not determine page count for ${pdfPath}`);
    }
    return Number(match[1]);
}

// pdftoppm's -gray PGM output is always "P5\n<width> <height>\n<maxval>\n"
// followed by one byte per pixel, with no comments -- no need for a general
// PGM parser here.
function parsePgm(buffer) {
    const line1End = buffer.indexOf(0x0a);
    const magic = buffer.toString('ascii', 0, line1End);
    if (magic !== 'P5') {
        throw new Error(`Expected a binary (P5) PGM file, got magic "${magic}"`);
    }
    const line2End = buffer.indexOf(0x0a, line1End + 1);
    const [
        width,
        height,
    ] = buffer.toString('ascii', line1End + 1, line2End).trim().split(/\s+/u).map(Number);
    const line3End = buffer.indexOf(0x0a, line2End + 1);
    const maxValue = Number(buffer.toString('ascii', line2End + 1, line3End).trim());
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('Invalid PGM header');
    }
    if (maxValue !== 255) {
        throw new Error(`Unsupported PGM maxval ${String(maxValue)} (expected 255)`);
    }
    const data = buffer.subarray(line3End + 1, line3End + 1 + width * height);
    if (data.length !== width * height) {
        throw new Error('Truncated PGM pixel data');
    }
    return {
        data,
        height,
        width,
    };
}

function pageNumberFromFileName(fileName) {
    const match = /-(\d+)\.pgm$/u.exec(fileName);
    return match ? Number(match[1]) : null;
}

async function renderPdfPagesGray({
    dpi,
    label,
    pageCount,
    pdfPath,
    workDirectory,
}) {
    const prefix = join(workDirectory, label);
    await run('pdftoppm', [
        '-f',
        '1',
        '-l',
        String(pageCount),
        '-r',
        String(dpi),
        '-gray',
        pdfPath,
        prefix,
    ]);
    const entries = await readdir(workDirectory);
    const pages = new Map();
    for (const entry of entries) {
        if (!entry.startsWith(`${label}-`) || !entry.endsWith('.pgm')) {
            continue;
        }
        const pageNumber = pageNumberFromFileName(entry);
        if (pageNumber === null) {
            continue;
        }
        const filePath = join(workDirectory, entry);
        pages.set(pageNumber, parsePgm(await readFile(filePath)));
        await rm(filePath, {force: true});
    }
    return pages;
}

function cropColumns(bitmap, startX, endX) {
    const width = endX - startX;
    const data = new Uint8Array(width * bitmap.height);
    for (let y = 0; y < bitmap.height; y += 1) {
        const sourceOffset = y * bitmap.width + startX;
        data.set(bitmap.data.subarray(sourceOffset, sourceOffset + width), y * width);
    }
    return {
        data,
        height: bitmap.height,
        width,
    };
}

function splitHalves(bitmap) {
    const leftWidth = Math.floor(bitmap.width / 2);
    return {
        left: cropColumns(bitmap, 0, leftWidth),
        right: cropColumns(bitmap, leftWidth, bitmap.width),
    };
}

// Min-pool a bitmap into a cols x rows grid of booleans: a cell is "dark" if
// any sample within it is below INK_THRESHOLD. Min-pooling (rather than
// averaging) is what lets a one-pixel-wide rule or a thin footnote digit
// register instead of being diluted away by a mostly-white cell.
function minPoolGrid(
    bitmap,
    cols,
    rows,
    threshold = INK_THRESHOLD,
    offsetX = 0,
    offsetY = 0,
) {
    const dark = new Uint8Array(cols * rows);
    let darkCount = 0;
    for (let row = 0; row < rows; row += 1) {
        const y0 = Math.floor((row * bitmap.height) / rows) - offsetY;
        const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * bitmap.height) / rows) - offsetY);
        for (let col = 0; col < cols; col += 1) {
            const x0 = Math.floor((col * bitmap.width) / cols) - offsetX;
            const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * bitmap.width) / cols) - offsetX);
            let minValue = 255;
            for (let y = Math.max(0, y0); y < Math.min(bitmap.height, y1); y += 1) {
                const rowOffset = y * bitmap.width;
                for (let x = Math.max(0, x0); x < Math.min(bitmap.width, x1); x += 1) {
                    minValue = Math.min(minValue, bitmap.data[rowOffset + x]);
                }
            }
            if (minValue < threshold) {
                dark[row * cols + col] = 1;
                darkCount += 1;
            }
        }
    }
    return {
        cols,
        dark,
        inkFraction: darkCount / (cols * rows),
        rows,
    };
}

function findGridComponents(grid) {
    const visited = new Uint8Array(grid.dark.length);
    const components = [];
    for (let index = 0; index < grid.dark.length; index += 1) {
        if (!grid.dark[index] || visited[index]) {
            continue;
        }
        const queue = [index];
        const cells = [];
        visited[index] = 1;
        let minX = grid.cols;
        let maxX = -1;
        let minY = grid.rows;
        let maxY = -1;
        let interiorCells = 0;
        for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
            const cellIndex = queue[queueIndex];
            const y = Math.floor(cellIndex / grid.cols);
            const x = cellIndex % grid.cols;
            cells.push(cellIndex);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            if (
                x >= STRUCTURE_INTERIOR_MARGIN_CELLS
                && x < grid.cols - STRUCTURE_INTERIOR_MARGIN_CELLS
                && y >= STRUCTURE_INTERIOR_MARGIN_CELLS
                && y < grid.rows - STRUCTURE_INTERIOR_MARGIN_CELLS
            ) {
                interiorCells += 1;
            }
            for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
                for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
                    if (deltaX === 0 && deltaY === 0) {
                        continue;
                    }
                    const neighborX = x + deltaX;
                    const neighborY = y + deltaY;
                    if (
                        neighborX < 0
                        || neighborY < 0
                        || neighborX >= grid.cols
                        || neighborY >= grid.rows
                    ) {
                        continue;
                    }
                    const neighborIndex = neighborY * grid.cols + neighborX;
                    if (grid.dark[neighborIndex] && !visited[neighborIndex]) {
                        visited[neighborIndex] = 1;
                        queue.push(neighborIndex);
                    }
                }
            }
        }
        components.push({
            area: cells.length,
            cells,
            height: maxY - minY + 1,
            interiorCells,
            maxX,
            maxY,
            minX,
            minY,
            width: maxX - minX + 1,
        });
    }
    return components;
}

function componentTouchesBoundary(component, grid) {
    return component.minX === 0
        || component.minY === 0
        || component.maxX === grid.cols - 1
        || component.maxY === grid.rows - 1;
}

function isStructuredComponent(component, grid) {
    if (component.area < MIN_STRUCTURED_COMPONENT_CELLS) {
        return false;
    }
    const touchesBoundary = componentTouchesBoundary(component, grid);
    const edgeThin = touchesBoundary && (
        (
            component.width <= EDGE_RESIDUE_MAX_THICKNESS_CELLS
            && component.height >= grid.rows * EDGE_RESIDUE_MIN_SPAN_FRACTION
        )
        || (
            component.height <= EDGE_RESIDUE_MAX_THICKNESS_CELLS
            && component.width >= grid.cols * EDGE_RESIDUE_MIN_SPAN_FRACTION
        )
    );
    if (edgeThin) {
        return false;
    }
    return component.interiorCells >= 2 || !touchesBoundary;
}

function addComponentToGrid(target, component) {
    for (const cellIndex of component.cells) {
        target[cellIndex] = 1;
    }
}

function isFullFrameField(component, grid, minimumFraction) {
    return component.area / grid.dark.length >= minimumFraction
        && component.width >= grid.cols * 0.95
        && component.height >= grid.rows * 0.95;
}

function gridWithDarkCells(dark, cols, rows) {
    let darkCount = 0;
    for (const cell of dark) {
        darkCount += cell;
    }
    return {
        cols,
        dark,
        inkFraction: darkCount / (cols * rows),
        rows,
    };
}

function findStructuredEdge(grid) {
    const candidates = [
        {
            cells: [],
            max: -1,
            min: grid.rows,
        },
        {
            cells: [],
            max: -1,
            min: grid.rows,
        },
        {
            cells: [],
            max: -1,
            min: grid.cols,
        },
        {
            cells: [],
            max: -1,
            min: grid.cols,
        },
    ];
    for (let index = 0; index < grid.dark.length; index += 1) {
        if (!grid.dark[index]) {
            continue;
        }
        const y = Math.floor(index / grid.cols);
        const x = index % grid.cols;
        const edgeIndexes = [];
        if (x < EDGE_STRUCTURE_STRIP_CELLS) {
            edgeIndexes.push(0);
        }
        if (x >= grid.cols - EDGE_STRUCTURE_STRIP_CELLS) {
            edgeIndexes.push(1);
        }
        if (y < EDGE_STRUCTURE_STRIP_CELLS) {
            edgeIndexes.push(2);
        }
        if (y >= grid.rows - EDGE_STRUCTURE_STRIP_CELLS) {
            edgeIndexes.push(3);
        }
        for (const edgeIndex of edgeIndexes) {
            const candidate = candidates[edgeIndex];
            candidate.cells.push(index);
            const coordinate = edgeIndex < 2 ? y : x;
            candidate.min = Math.min(candidate.min, coordinate);
            candidate.max = Math.max(candidate.max, coordinate);
        }
    }

    const structuredDark = new Uint8Array(grid.dark.length);
    for (const [
        index,
        candidate,
    ] of candidates.entries()) {
        const spanLength = candidate.max < 0 ? 0 : candidate.max - candidate.min + 1;
        const spanLimit = index < 2 ? grid.rows : grid.cols;
        if (
            candidate.cells.length < MIN_EDGE_STRUCTURE_CELLS
            || spanLength < spanLimit * MIN_EDGE_STRUCTURE_SPAN_FRACTION
        ) {
            continue;
        }
        for (const cellIndex of candidate.cells) {
            structuredDark[cellIndex] = 1;
        }
    }
    return gridWithDarkCells(structuredDark, grid.cols, grid.rows);
}

function analyzeBitmap(bitmap) {
    const coarse = minPoolGrid(bitmap, COARSE_COLS, COARSE_ROWS);
    const structureGrid = minPoolGrid(
        bitmap,
        STRUCTURE_COLS,
        STRUCTURE_ROWS,
        STRUCTURED_INK_THRESHOLD,
    );
    const structureComponents = findGridComponents(structureGrid);
    const structuredDark = new Uint8Array(structureGrid.dark.length);
    for (const component of structureComponents) {
        if (isStructuredComponent(component, structureGrid)) {
            addComponentToGrid(structuredDark, component);
        }
    }

    // A full-frame dark field is semantic page content for the purposes of
    // preservation, even when its tone is lighter than ordinary text. This
    // covers full-bleed covers and color plates without promoting diffuse
    // ghosting or a one-pixel rail to content.
    const layoutGrid = minPoolGrid(bitmap, STRUCTURE_COLS, STRUCTURE_ROWS);
    const fullPageField = findGridComponents(layoutGrid).find(component => isFullFrameField(
        component,
        layoutGrid,
        SEMANTIC_FULL_PAGE_FIELD_MIN_FRACTION,
    ));
    if (fullPageField) {
        addComponentToGrid(structuredDark, fullPageField);
    }

    const structured = gridWithDarkCells(structuredDark, STRUCTURE_COLS, STRUCTURE_ROWS);
    const structuredEdge = findStructuredEdge(structureGrid);
    const geometryDark = new Uint8Array(structured.dark);
    for (let index = 0; index < geometryDark.length; index += 1) {
        if (structuredEdge.dark[index]) {
            geometryDark[index] = 1;
        }
    }

    return {
        coarse,
        layoutGrid,
        structured,
        structuredEdge,
        geometry: gridWithDarkCells(geometryDark, STRUCTURE_COLS, STRUCTURE_ROWS),
    };
}

function jaccardSimilarity(gridA, gridB) {
    let intersection = 0;
    let union = 0;
    for (let index = 0; index < gridA.dark.length; index += 1) {
        const a = gridA.dark[index];
        const b = gridB.dark[index];
        if (a || b) {
            union += 1;
            intersection += a && b ? 1 : 0;
        }
    }
    return union === 0 ? 1 : intersection / union;
}

function scoreBitmapTranslation(sourceGrid, cleanedBitmap, offsetX, offsetY) {
    const cleanedGrid = minPoolGrid(
        cleanedBitmap,
        sourceGrid.cols,
        sourceGrid.rows,
        INK_THRESHOLD,
        offsetX,
        offsetY,
    );
    let intersection = 0;
    let cleanedDark = 0;
    let sourceDark = 0;
    for (let index = 0; index < sourceGrid.dark.length; index += 1) {
        const sourceValue = sourceGrid.dark[index];
        const cleanedValue = cleanedGrid.dark[index];
        sourceDark += sourceValue;
        cleanedDark += cleanedValue;
        intersection += sourceValue && cleanedValue ? 1 : 0;
    }
    const union = sourceDark + cleanedDark - intersection;
    return {
        cleanedGrid,
        intersection,
        offsetX,
        offsetY,
        overlap: sourceDark === 0 ? 1 : intersection / sourceDark,
        similarity: union === 0 ? 1 : intersection / union,
    };
}

function isBetterAlignment(candidate, best) {
    if (candidate.intersection !== best.intersection) {
        return candidate.intersection > best.intersection;
    }
    const candidateDistance = Math.abs(candidate.offsetX) + Math.abs(candidate.offsetY);
    const bestDistance = Math.abs(best.offsetX) + Math.abs(best.offsetY);
    if (candidateDistance !== bestDistance) {
        return candidateDistance < bestDistance;
    }
    if (candidate.similarity !== best.similarity) {
        return candidate.similarity > best.similarity;
    }
    if (Math.abs(candidate.offsetY) !== Math.abs(best.offsetY)) {
        return Math.abs(candidate.offsetY) < Math.abs(best.offsetY);
    }
    return candidate.offsetX < best.offsetX;
}

function searchBitmapTranslation({
    centerX,
    centerY,
    cleanedBitmap,
    maxX,
    maxY,
    radiusX,
    radiusY,
    sourceGrid,
    step,
}) {
    const startX = Math.max(-maxX, centerX - radiusX);
    const endX = Math.min(maxX, centerX + radiusX);
    const startY = maxY === 0 ? 0 : Math.max(-maxY, centerY - radiusY);
    const endY = maxY === 0 ? 0 : Math.min(maxY, centerY + radiusY);
    let best = scoreBitmapTranslation(sourceGrid, cleanedBitmap, centerX, centerY);
    for (let offsetY = startY; offsetY <= endY; offsetY += step) {
        for (let offsetX = startX; offsetX <= endX; offsetX += step) {
            const candidate = scoreBitmapTranslation(
                sourceGrid,
                cleanedBitmap,
                offsetX,
                offsetY,
            );
            if (isBetterAlignment(candidate, best)) {
                best = candidate;
            }
        }
    }
    return best;
}

export function alignBitmapForComparison(sourceBitmap, cleanedBitmap) {
    const sourceGrid = minPoolGrid(sourceBitmap, COARSE_COLS, COARSE_ROWS);
    const maxX = Math.floor(cleanedBitmap.width * ALIGNMENT_MAX_TRANSLATION_FRACTION);
    // Optical placement moves horizontally; keeping y fixed prevents this
    // normalization from concealing vertical squeeze or page-cascade damage.
    const maxY = 0;
    const initialStep = Math.max(1, Math.floor(Math.min(
        cleanedBitmap.width / COARSE_COLS,
        cleanedBitmap.height / COARSE_ROWS,
    ) / 4));
    const steps = [
        initialStep,
        Math.max(1, Math.floor(initialStep / 4)),
        1,
    ].filter((step, index, values) => values.indexOf(step) === index);
    let best = scoreBitmapTranslation(sourceGrid, cleanedBitmap, 0, 0);
    let radiusX = maxX;
    let radiusY = maxY;
    for (const step of steps) {
        best = searchBitmapTranslation({
            centerX: best.offsetX,
            centerY: best.offsetY,
            cleanedBitmap,
            maxX,
            maxY,
            radiusX,
            radiusY,
            sourceGrid,
            step,
        });
        radiusX = step;
        radiusY = step;
    }

    const accepted = best.overlap >= ALIGNMENT_MIN_OVERLAP
        && best.similarity >= ALIGNMENT_MIN_SIMILARITY;
    const appliedOffsetPixels = {
        x: accepted ? best.offsetX : 0,
        y: accepted ? best.offsetY : 0,
    };
    return {
        grid: accepted
            ? best.cleanedGrid
            : minPoolGrid(cleanedBitmap, COARSE_COLS, COARSE_ROWS),
        metrics: {
            applied: accepted && (best.offsetX !== 0 || best.offsetY !== 0),
            appliedOffsetPixels,
            bestOverlap: round(best.overlap),
            bestSimilarity: round(best.similarity),
            maxTranslationFraction: ALIGNMENT_MAX_TRANSLATION_FRACTION,
            maxTranslationPixels: {
                x: maxX,
                y: maxY,
            },
            offsetPixels: {
                x: best.offsetX,
                y: best.offsetY,
            },
            rejected: !accepted,
            rejectionReason: accepted ? null : 'best-overlap-or-similarity-below-threshold',
        },
    };
}

export function measureSpreadLeafVerticalAlignment(args) {
    return measureSpreadLeafVerticalAlignmentImpl({
        ...args,
        dpi: args.dpi ?? DEFAULT_DPI,
    });
}

function round(value) {
    return Math.round(value * 10_000) / 10_000;
}

function auditHalf({
    cleanedBitmap,
    cleanedPage,
    side,
    sourceBitmap,
    sourcePage,
}) {
    const sourceAnalysis = analyzeBitmap(sourceBitmap);
    const record = {
        cleanedPage,
        side,
        sourcePage,
        srcInk: round(sourceAnalysis.coarse.inkFraction),
        structuredSrcInk: round(sourceAnalysis.structured.inkFraction),
        structuredEdgeSrcInk: round(sourceAnalysis.structuredEdge.inkFraction),
        violations: [],
    };
    if (!cleanedBitmap) {
        record.cleanInk = null;
        record.mappingStatus = 'missing-cleaned-page';
        record.note = 'no cleaned page at the inferred mapped index (page-count mismatch is reported once at fixture level)';
        return record;
    }
    const cleanedAnalysis = analyzeBitmap(cleanedBitmap);
    const alignment = alignBitmapForComparison(sourceBitmap, cleanedBitmap);
    // Structured ink decides meaning; retention and shape stay on the coarse grid after bounded placement
    // normalization so optical centering does not change the verdict merely
    // by moving the same raster across min-pool cell boundaries.
    const similarity = jaccardSimilarity(sourceAnalysis.coarse, alignment.grid);
    const sourceBboxHeight = contentBboxHeightFraction(sourceAnalysis.geometry);
    const cleanedBboxHeight = contentBboxHeightFraction(cleanedAnalysis.geometry);
    const bboxRatio = sourceBboxHeight === 0 ? null : cleanedBboxHeight / sourceBboxHeight;
    // Confirm fragmented low-contrast geometry on an edge-trimmed coarse grid;
    // the separate structured-edge branch below still catches scanner rails.
    const sourceCoarseBboxHeight = contentBboxHeightFraction(
        sourceAnalysis.coarse,
        GEOMETRY_INTERIOR_MARGIN_CELLS,
    );
    const cleanedCoarseBboxHeight = contentBboxHeightFraction(
        alignment.grid,
        GEOMETRY_INTERIOR_MARGIN_CELLS,
    );
    const coarseBboxRatio = sourceCoarseBboxHeight === 0
        ? null
        : cleanedCoarseBboxHeight / sourceCoarseBboxHeight;
    record.cleanInk = round(cleanedAnalysis.coarse.inkFraction);
    record.alignedCleanInk = round(alignment.grid.inkFraction);
    record.alignment = alignment.metrics;
    record.structuredCleanInk = round(cleanedAnalysis.structured.inkFraction);
    record.structuredEdgeCleanInk = round(cleanedAnalysis.structuredEdge.inkFraction);
    record.similarity = round(similarity);
    record.bboxHeightFraction = {
        cleaned: round(cleanedBboxHeight),
        ratio: bboxRatio === null ? null : round(bboxRatio),
        source: round(sourceBboxHeight),
        coarseInterior: {
            cleaned: round(cleanedCoarseBboxHeight),
            ratio: coarseBboxRatio === null ? null : round(coarseBboxRatio),
            source: round(sourceCoarseBboxHeight),
        },
    };

    // A raster that collapsed to a tiny placeholder is not evidence that the
    // source page was blank. Do not call every cleaned pixel an invented
    // artifact when the source raster itself is uninformative.
    if (sourceBitmap.width < STRUCTURE_COLS || sourceBitmap.height < STRUCTURE_ROWS) {
        record.note = 'content checks skipped because the rendered source raster is too small for structured-ink classification';
        return record;
    }

    // (c) Clean blanks: a near-blank source half must not retain a
    // scanner-artifact streak (e.g. gutter fold shadow) in the output. Raw
    // min-pooled ink is deliberately not used here: one edge component or a
    // pale ghost can occupy many coarse cells without being semantic content.
    if (sourceAnalysis.structured.inkFraction < STRUCTURED_BLANK_INK_FRACTION) {
        if (
            sourceAnalysis.coarse.inkFraction < BLANK_INK_FRACTION
            && (
                cleanedAnalysis.structured.inkFraction > STRUCTURED_BLANK_MAX_CLEANED_INK_FRACTION
                || cleanedAnalysis.structuredEdge.inkFraction > STRUCTURED_EDGE_ARTIFACT_MIN_FRACTION
            )
        ) {
            record.violations.push('artifact-retention');
        } else if (sourceAnalysis.coarse.inkFraction >= BLANK_INK_FRACTION) {
            record.note = 'unstructured source ink ignored for preservation checks';
        }
        if (sourceAnalysis.structuredEdge.inkFraction < EDGE_GEOMETRY_MIN_FRACTION) {
            return record;
        }
    }

    // (b) Ink retention: meaningful content must survive both in quantity
    // (retention ratio) and in shape (Jaccard), unless the page is too pale
    // for shape comparison to be meaningful (see SIMILARITY_MIN_INK_FRACTION).
    // (d) No squeeze: the cleaned page must fill roughly as much of its own
    // height with content as the source half did. Geometry is intentionally
    // skipped for a short source content island; its height is not a stable
    // reference for a normalized page canvas.
    if (sourceAnalysis.structured.inkFraction > STRUCTURED_CONTENT_INK_FRACTION) {
        const retention = alignment.grid.inkFraction / sourceAnalysis.coarse.inkFraction;
        record.retention = round(retention);
        const checkSimilarity = sourceAnalysis.coarse.inkFraction >= SIMILARITY_MIN_INK_FRACTION;
        const failedRetention = retention < CONTENT_MIN_RETENTION;
        const failedSimilarity = checkSimilarity && similarity < CONTENT_MIN_SIMILARITY;
        if (failedRetention || failedSimilarity) {
            record.violations.push('content-loss');
        }
        const geometrySourceIsTallEnough = sourceBboxHeight >= GEOMETRY_MIN_SOURCE_BBOX_HEIGHT_FRACTION;
        record.bboxHeightFraction.geometryChecked = geometrySourceIsTallEnough;
        if (!geometrySourceIsTallEnough) {
            record.bboxHeightFraction.geometrySkip = 'source-content-bbox-short';
        } else if (
            bboxRatio !== null
            && bboxRatio < GEOMETRY_MIN_HEIGHT_RATIO
            && coarseBboxRatio !== null
            && coarseBboxRatio < GEOMETRY_MIN_HEIGHT_RATIO
        ) {
            record.violations.push('geometry');
        }
    } else if (sourceAnalysis.structuredEdge.inkFraction >= EDGE_GEOMETRY_MIN_FRACTION) {
        // A long, aligned edge rail is not semantic page content, but it is
        // still a stable cosmetic geometry reference (the Malkuno fixture).
        // Use it only for the height check; it must not enter retention or
        // shape scoring as if it were text.
        record.bboxHeightFraction.geometryChecked = true;
        if (bboxRatio !== null && bboxRatio < GEOMETRY_MIN_HEIGHT_RATIO) {
            record.violations.push('geometry');
        }
    }
    return record;
}

function inferSourcePageLayout(bitmap) {
    const aspectRatio = bitmap.width / bitmap.height;
    if (aspectRatio < LAYOUT_MIN_ASPECT_RATIO) {
        return {
            layout: 'single',
            reason: 'portrait-or-near-square-source',
        };
    }

    const layoutGrid = minPoolGrid(bitmap, STRUCTURE_COLS, STRUCTURE_ROWS);
    const fullPageField = findGridComponents(layoutGrid).find(component => isFullFrameField(
        component,
        layoutGrid,
        FULL_PAGE_FIELD_MIN_FRACTION,
    ));
    if (fullPageField) {
        return {
            layout: 'single',
            reason: 'full-frame-source-field',
        };
    }

    const sourceHalves = splitHalves(bitmap);
    const halves = [
        sourceHalves.left,
        sourceHalves.right,
    ];
    const halfInk = halves.map(half => minPoolGrid(
        half,
        STRUCTURE_COLS / 2,
        STRUCTURE_ROWS,
    ).inkFraction);
    if (Math.min(...halfInk) >= LAYOUT_MIN_HALF_INK_FRACTION) {
        return {
            halfInk: halfInk.map(round),
            layout: 'spread',
            reason: 'bilateral-source-ink',
        };
    }
    return {
        halfInk: halfInk.map(round),
        layout: 'single',
        reason: 'one-sided-or-sparse-source',
    };
}

function layoutForSourcePages(sourcePageCount, sourcePages) {
    if (!sourcePages || sourcePages.size === 0) {
        return Array.from({length: sourcePageCount}, () => 'unknown');
    }
    return Array.from({length: sourcePageCount}, (_, index) => {
        const bitmap = sourcePages.get(index + 1);
        return bitmap ? inferSourcePageLayout(bitmap).layout : 'unknown';
    });
}

function buildEntriesForLayouts(layouts) {
    const entries = [];
    let cursor = 1;
    for (const [
        index,
        layout,
    ] of layouts.entries()) {
        const sourcePage = index + 1;
        if (layout === 'single' || layout === 'unknown') {
            entries.push({
                cleanedPage: cursor,
                side: 'whole',
                sourcePage,
                sourceLayout: layout,
            });
            cursor += 1;
        } else {
            entries.push({
                cleanedPage: cursor,
                side: 'left',
                sourcePage,
                sourceLayout: layout,
            });
            entries.push({
                cleanedPage: cursor + 1,
                side: 'right',
                sourcePage,
                sourceLayout: layout,
            });
            cursor += 2;
        }
    }
    return {
        entries,
        expectedCleanedCount: cursor - 1,
    };
}

// Infer the mapping from rendered pages, not from a corpus stratum. For a
// one-page source this means an actual two-page output is audited as a split,
// while an actual one-page output is compared as a whole page. Bilateral
// source evidence can still raise the expected count and produce a page-count
// finding for an unsplit output. The optional rendered source map also
// supports mixed multi-page documents when its visual layout agrees with the
// output count.
export function buildExpectedMapping(sourcePageCount, actualCleanedCount, sourcePages = null) {
    const visualLayouts = layoutForSourcePages(sourcePageCount, sourcePages);
    const visualExpectedCount = visualLayouts.reduce(
        (count, layout) => count + (layout === 'spread' ? 2 : 1),
        0,
    );
    let layouts;
    let entries;
    let expectedCleanedCount;
    let reason;
    if (sourcePages && actualCleanedCount === visualExpectedCount) {
        layouts = visualLayouts;
        reason = 'rendered-source-layout-and-output-count';
    } else if (actualCleanedCount === sourcePageCount) {
        layouts = sourcePages
            ? visualLayouts
            : Array.from({length: sourcePageCount}, () => 'single');
        reason = 'one-output-page-per-source-page';
    } else if (actualCleanedCount >= sourcePageCount * 2) {
        layouts = Array.from({length: sourcePageCount}, () => 'spread');
        reason = 'two-output-pages-per-source-page';
    } else if (actualCleanedCount > sourcePageCount) {
        // A partial split is closer to the spread contract than the single
        // contract. Keep the complete inferred mapping so the missing output
        // is reported as one fixture-level page-count finding.
        layouts = Array.from({length: sourcePageCount}, () => 'spread');
        reason = 'partial-split-output';
    } else {
        layouts = Array.from({length: sourcePageCount}, () => 'single');
        reason = 'short-output-count';
    }
    ({
        entries,
        expectedCleanedCount,
    } = buildEntriesForLayouts(layouts));
    if (actualCleanedCount === sourcePageCount && expectedCleanedCount !== actualCleanedCount) {
        // The output count still determines the page-to-page comparison when
        // a visually bilateral source was left unsplit. Preserve that whole
        // page for content/geometry checks, while retaining the visual
        // expected count so the missing split remains a page-count finding.
        entries = buildEntriesForLayouts(
            Array.from({length: sourcePageCount}, () => 'single'),
        ).entries;
    }
    return {
        entries,
        expectedCleanedCount,
        inferredLayouts: layouts,
        reason,
        visualLayouts,
        visualExpectedCount,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        return 0;
    }

    const sourcePageCount = await getPdfPageCount(options.source);
    const actualCleanedCount = await getPdfPageCount(options.cleaned);

    const workDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-repr-audit-'));
    let pages;
    let sourcePages;
    let cleanedPages;
    try {
        [
            sourcePages,
            cleanedPages,
        ] = await Promise.all([
            renderPdfPagesGray({
                dpi: options.dpi,
                label: 'src',
                pageCount: sourcePageCount,
                pdfPath: options.source,
                workDirectory,
            }),
            renderPdfPagesGray({
                dpi: options.dpi,
                label: 'clean',
                pageCount: actualCleanedCount,
                pdfPath: options.cleaned,
                workDirectory,
            }),
        ]);
        const mapping = buildExpectedMapping(sourcePageCount, actualCleanedCount, sourcePages);
        const {
            entries,
            expectedCleanedCount,
        } = mapping;
        const pageCountMismatch = actualCleanedCount !== expectedCleanedCount;
        pages = entries.map(entry => {
            const sourceBitmap = sourcePages.get(entry.sourcePage);
            if (!sourceBitmap) {
                throw new Error(`Missing rendered source page ${String(entry.sourcePage)}`);
            }
            const sourceHalfBitmap = entry.side === 'whole' ? sourceBitmap : splitHalves(sourceBitmap)[entry.side];
            return auditHalf({
                cleanedBitmap: cleanedPages.get(entry.cleanedPage) ?? null,
                cleanedPage: entry.cleanedPage,
                side: entry.side,
                sourceBitmap: sourceHalfBitmap,
                sourcePage: entry.sourcePage,
            });
        });
        const leafPairAlignment = buildSpreadLeafAlignment({
            cleanedPages,
            dpi: options.dpi,
            entries,
            sourcePages,
            splitHalves,
        });

        const infos = buildExpectationInfosImpl({
            expectSingles: options.expectSingles,
            inferredLayouts: mapping.inferredLayouts,
        });
        const violationCounts = {
            'artifact-retention': 0,
            'content-loss': 0,
            geometry: 0,
            'leaf-misalignment': 0,
            'page-count': pageCountMismatch ? 1 : 0,
        };
        for (const page of pages) {
            for (const violation of page.violations) {
                violationCounts[violation] += 1;
            }
        }
        for (const pair of leafPairAlignment) {
            for (const violation of pair.violations) {
                violationCounts[violation] += 1;
            }
        }
        const totalViolations = Object.values(violationCounts).reduce((sum, count) => sum + count, 0);

        const report = {
            cleaned: options.cleaned,
            infos,
            mapping: {
                inferredLayouts: mapping.inferredLayouts,
                reason: mapping.reason,
                visualLayouts: mapping.visualLayouts,
                visualExpectedCount: mapping.visualExpectedCount,
            },
            leafPairAlignment,
            pages,
            source: options.source,
            summary: {
                actualCleanedCount,
                expectedCleanedCount,
                infoCount: infos.length,
                leafPairCount: leafPairAlignment.length,
                leafMisalignmentPairs: leafPairAlignment.filter(pair => pair.status === 'violation').length,
                pageCountMismatch,
                sourcePageCount,
                totalViolations,
                violationCounts,
            },
        };
        await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log(`Wrote ${options.out}`);
        console.log(`Source pages: ${String(sourcePageCount)}, inferred cleaned pages: ${String(expectedCleanedCount)}, actual cleaned pages: ${String(actualCleanedCount)}`);
        console.log(`Violations: ${JSON.stringify(violationCounts)}`);
        if (infos.length > 0) {
            console.log(`Infos: ${JSON.stringify(infos.map(info => info.code))}`);
        }
        return totalViolations > 0 ? 1 : 0;
    } finally {
        await rm(workDirectory, {
            force: true,
            recursive: true,
        });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().then(
        exitCode => {
            process.exitCode = exitCode;
        },
        error => {
            console.error(error instanceof Error ? error.message : error);
            process.exitCode = 1;
        },
    );
}
