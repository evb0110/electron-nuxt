#!/usr/bin/env node
// Oracle audit for the scan-cleanup representative fixture. Renders source and
// cleaned PDFs to low-DPI grayscale PGM with pdftoppm, splits each source
// spread into left/right halves, and checks that every half survived the
// pipeline: no page dropped, no ink invented on a blank verso, no content
// erased, no page squeezed instead of split. Coarse pixel-grid oracle (~50 DPI,
// 20x28 / 40x56 cell grids) -- catches gross regressions cheaply, not a
// replacement for the finer word-loss audit.

import {execFile} from 'node:child_process';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {tsImport} from 'tsx/esm/api';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const {resolveCliNativeToolPath} = await tsImport('../scanCleanupCliAdapters.ts', import.meta.url);

// Both pdfinfo and pdftoppm ship in the poppler native resource bundle; see
// scan-cleanup-word-loss-audit.mjs for the same resolution pattern.
const AUDIT_TOOL_CRATES = {pdfinfo: 'poppler', pdftoppm: 'poppler'};
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
// Finer grid used only to locate the vertical extent of content, for the
// "no squeeze" geometry check.
const FINE_COLS = 40;
const FINE_ROWS = 56;
// Below this ink fraction a source half is a blank verso: the mapped cleaned
// page must not have picked up a gutter-shadow streak.
const BLANK_INK_FRACTION = 0.005;
const BLANK_MAX_CLEANED_INK_FRACTION = 0.004;
// At/above this ink fraction a source half is "meaningful content": the
// mapped cleaned page must retain most of it and land on the same shape.
const CONTENT_INK_FRACTION = 0.02;
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
// The cleaned page's content bounding-box height (as a fraction of page
// height) must be at least this fraction of the source half's, or the page
// was squeezed into part of the canvas instead of filling it.
const GEOMETRY_MIN_HEIGHT_RATIO = 0.6;

function parseArgs(argv) {
    const options = {cleaned: null, dpi: DEFAULT_DPI, expectSingles: new Set(), out: null, source: null};
    const valueArguments = new Set(['--cleaned', '--dpi', '--expect-singles', '--out', '--source']);
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') {
            printHelp();
            return {...options, help: true};
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

Checks that every left/right half of every source spread survived the
scan-cleanup pipeline: page count conserved, no ink invented on blank versos,
no content erased, no page squeezed instead of split.

Options:
  --source <pdf>          Source (pre-pipeline) PDF, e.g. the representative fixture
  --cleaned <pdf>          Pipeline output PDF to audit
  --out <json>             Report path (required)
  --expect-singles <list>  Comma-separated 1-based source page numbers that are
                            legitimately single pages, not spreads (default: none)
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
    const [width, height] = buffer.toString('ascii', line1End + 1, line2End).trim().split(/\s+/u).map(Number);
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
    return {data, height, width};
}

function pageNumberFromFileName(fileName) {
    const match = /-(\d+)\.pgm$/u.exec(fileName);
    return match ? Number(match[1]) : null;
}

async function renderPdfPagesGray({dpi, label, pageCount, pdfPath, workDirectory}) {
    const prefix = join(workDirectory, label);
    await run('pdftoppm', ['-f', '1', '-l', String(pageCount), '-r', String(dpi), '-gray', pdfPath, prefix]);
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
    return {data, height: bitmap.height, width};
}

function splitHalves(bitmap) {
    const leftWidth = Math.floor(bitmap.width / 2);
    return {left: cropColumns(bitmap, 0, leftWidth), right: cropColumns(bitmap, leftWidth, bitmap.width)};
}

// Min-pool a bitmap into a cols x rows grid of booleans: a cell is "dark" if
// any sample within it is below INK_THRESHOLD. Min-pooling (rather than
// averaging) is what lets a one-pixel-wide rule or a thin footnote digit
// register instead of being diluted away by a mostly-white cell.
function minPoolGrid(bitmap, cols, rows) {
    const dark = new Uint8Array(cols * rows);
    let darkCount = 0;
    for (let row = 0; row < rows; row += 1) {
        const y0 = Math.floor((row * bitmap.height) / rows);
        const y1 = Math.max(y0 + 1, Math.floor(((row + 1) * bitmap.height) / rows));
        for (let col = 0; col < cols; col += 1) {
            const x0 = Math.floor((col * bitmap.width) / cols);
            const x1 = Math.max(x0 + 1, Math.floor(((col + 1) * bitmap.width) / cols));
            let minValue = 255;
            for (let y = y0; y < y1; y += 1) {
                const rowOffset = y * bitmap.width;
                for (let x = x0; x < x1; x += 1) {
                    minValue = Math.min(minValue, bitmap.data[rowOffset + x]);
                }
            }
            if (minValue < INK_THRESHOLD) {
                dark[row * cols + col] = 1;
                darkCount += 1;
            }
        }
    }
    return {cols, dark, inkFraction: darkCount / (cols * rows), rows};
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

// Fraction of grid rows spanned by the topmost-to-bottommost dark cell, i.e.
// how much of the page height the content actually occupies. A page that got
// squeezed into the top half of its canvas has a much smaller value here than
// its source.
function contentBboxHeightFraction(grid) {
    let minRow = -1;
    let maxRow = -1;
    for (let row = 0; row < grid.rows; row += 1) {
        const rowOffset = row * grid.cols;
        const rowHasInk = grid.dark.subarray(rowOffset, rowOffset + grid.cols).some(cell => cell === 1);
        if (rowHasInk) {
            minRow = minRow === -1 ? row : minRow;
            maxRow = row;
        }
    }
    return minRow === -1 ? 0 : (maxRow - minRow + 1) / grid.rows;
}

function round(value) {
    return Math.round(value * 10_000) / 10_000;
}

function auditHalf({cleanedBitmap, cleanedPage, side, sourceBitmap, sourcePage}) {
    const sourceCoarse = minPoolGrid(sourceBitmap, COARSE_COLS, COARSE_ROWS);
    const record = {cleanedPage, side, sourcePage, srcInk: round(sourceCoarse.inkFraction), violations: []};
    if (!cleanedBitmap) {
        record.cleanInk = null;
        record.note = 'no cleaned page at the mapped index (page-count mismatch)';
        record.violations.push('page-count');
        return record;
    }
    const cleanedCoarse = minPoolGrid(cleanedBitmap, COARSE_COLS, COARSE_ROWS);
    const similarity = jaccardSimilarity(sourceCoarse, cleanedCoarse);
    const sourceBboxHeight = contentBboxHeightFraction(minPoolGrid(sourceBitmap, FINE_COLS, FINE_ROWS));
    const cleanedBboxHeight = contentBboxHeightFraction(minPoolGrid(cleanedBitmap, FINE_COLS, FINE_ROWS));
    const bboxRatio = sourceBboxHeight === 0 ? null : cleanedBboxHeight / sourceBboxHeight;
    record.cleanInk = round(cleanedCoarse.inkFraction);
    record.similarity = round(similarity);
    record.bboxHeightFraction = {
        cleaned: round(cleanedBboxHeight),
        ratio: bboxRatio === null ? null : round(bboxRatio),
        source: round(sourceBboxHeight),
    };

    // (c) Clean blanks: a near-blank source half must not retain a
    // scanner-artifact streak (e.g. gutter fold shadow) in the output.
    if (sourceCoarse.inkFraction < BLANK_INK_FRACTION) {
        if (cleanedCoarse.inkFraction > BLANK_MAX_CLEANED_INK_FRACTION) {
            record.violations.push('artifact-retention');
        }
        return record;
    }

    // (b) Ink retention: meaningful content must survive both in quantity
    // (retention ratio) and in shape (Jaccard), unless the page is too pale
    // for shape comparison to be meaningful (see SIMILARITY_MIN_INK_FRACTION).
    // (d) No squeeze: the cleaned page must fill roughly as much of its own
    // height with content as the source half did.
    if (sourceCoarse.inkFraction > CONTENT_INK_FRACTION) {
        const retention = cleanedCoarse.inkFraction / sourceCoarse.inkFraction;
        record.retention = round(retention);
        const checkSimilarity = sourceCoarse.inkFraction >= SIMILARITY_MIN_INK_FRACTION;
        const failedRetention = retention < CONTENT_MIN_RETENTION;
        const failedSimilarity = checkSimilarity && similarity < CONTENT_MIN_SIMILARITY;
        if (failedRetention || failedSimilarity) {
            record.violations.push('content-loss');
        }
        if (bboxRatio !== null && bboxRatio < GEOMETRY_MIN_HEIGHT_RATIO) {
            record.violations.push('geometry');
        }
    }
    return record;
}

// Expected mapping: source spread i -> cleaned pages 2i-1, 2i (1-based),
// unless i is in expectSingles, in which case it maps to a single cleaned
// page. Computed once up front from the fixture's page count, independent of
// what the pipeline actually produced -- a downstream page-count bug (e.g. an
// unsplit spread) will show up as later halves mapping to the wrong cleaned
// page, which is itself useful evidence of how far the corruption cascades.
function buildExpectedMapping(sourcePageCount, expectSingles) {
    const entries = [];
    let cursor = 1;
    for (let sourcePage = 1; sourcePage <= sourcePageCount; sourcePage += 1) {
        if (expectSingles.has(sourcePage)) {
            entries.push({cleanedPage: cursor, side: 'whole', sourcePage});
            cursor += 1;
        } else {
            entries.push({cleanedPage: cursor, side: 'left', sourcePage});
            entries.push({cleanedPage: cursor + 1, side: 'right', sourcePage});
            cursor += 2;
        }
    }
    return {entries, expectedCleanedCount: cursor - 1};
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        return 0;
    }

    const sourcePageCount = await getPdfPageCount(options.source);
    const actualCleanedCount = await getPdfPageCount(options.cleaned);
    const {entries, expectedCleanedCount} = buildExpectedMapping(sourcePageCount, options.expectSingles);

    const workDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-repr-audit-'));
    let pages;
    try {
        const [sourcePages, cleanedPages] = await Promise.all([
            renderPdfPagesGray({dpi: options.dpi, label: 'src', pageCount: sourcePageCount, pdfPath: options.source, workDirectory}),
            renderPdfPagesGray({dpi: options.dpi, label: 'clean', pageCount: actualCleanedCount, pdfPath: options.cleaned, workDirectory}),
        ]);
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
    } finally {
        await rm(workDirectory, {force: true, recursive: true});
    }

    const violationCounts = {'artifact-retention': 0, 'content-loss': 0, geometry: 0, 'page-count': 0};
    for (const page of pages) {
        for (const violation of page.violations) {
            violationCounts[violation] += 1;
        }
    }
    const pageCountMismatch = actualCleanedCount !== expectedCleanedCount;
    if (pageCountMismatch) {
        violationCounts['page-count'] += 1;
    }
    const totalViolations = Object.values(violationCounts).reduce((sum, count) => sum + count, 0);

    const report = {
        cleaned: options.cleaned,
        pages,
        source: options.source,
        summary: {
            actualCleanedCount,
            expectedCleanedCount,
            pageCountMismatch,
            sourcePageCount,
            totalViolations,
            violationCounts,
        },
    };
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${options.out}`);
    console.log(`Source pages: ${String(sourcePageCount)}, expected cleaned pages: ${String(expectedCleanedCount)}, actual cleaned pages: ${String(actualCleanedCount)}`);
    console.log(`Violations: ${JSON.stringify(violationCounts)}`);
    return totalViolations > 0 ? 1 : 0;
}

main().then(
    exitCode => {
        process.exitCode = exitCode;
    },
    error => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    },
);
