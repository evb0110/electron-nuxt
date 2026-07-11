import { execFileSync } from 'node:child_process';
import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    basename,
    dirname,
    join,
    resolve,
} from 'node:path';
import {
    PDFDocument,
    PDFName,
    PDFString,
    StandardFonts,
    rgb,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';
import { getCurrentSessionName } from '@scripts/electron-run/electronRunSessionPaths';
import { createPdfjsNodeDocumentOptions } from '@electron/search/createPdfjsNodeDocumentOptions';

const FIXTURE_ROOT_DIR = resolve(process.cwd(), '.devkit', 'tmp', 'e2e-fixtures');
const TRACKED_PROJECT_FIXTURE_DIR = resolve(process.cwd(), 'tests', 'fixtures', 'electron');
const LEGACY_PROJECT_FIXTURE_DIR = resolve(process.cwd(), '.devkit', 'test-pdfs');
const PROJECT_ROOT_FIXTURE_DIR = resolve(process.cwd(), '.devkit');
const LARGE_PDF_FIXTURE_ENV_VAR = 'EVB_E2E_LARGE_PDF_FIXTURE';
const LARGE_PDF_REQUIRE_ENV_VAR = 'EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE';
const DEFAULT_LARGE_PDF_FIXTURE = 'large-pdf-fixtures/turkish-english-lexicon-letter-bookmarks.pdf';
const DJVU_FIXTURE_ENV_VAR = 'EVB_E2E_DJVU_FIXTURE';
const DJVU_REQUIRE_ENV_VAR = 'EVB_E2E_REQUIRE_DJVU_FIXTURE';
const DEFAULT_DJVU_FIXTURE = 'djvu-fixtures/viewer-smoke.djvu';
const GENERATED_DJVU_FIXTURE_PAGE_COUNT = 100;
const GENERATED_DJVU_FIXTURE_WIDTH = 1200;
const GENERATED_DJVU_FIXTURE_HEIGHT = 1600;
const GENERATED_DJVU_FIXTURE_DPI = 150;
const GENERATED_DJVU_FIXTURE_FILENAME = [
    'generated-viewer-smoke',
    `${GENERATED_DJVU_FIXTURE_PAGE_COUNT}p`,
    `${GENERATED_DJVU_FIXTURE_WIDTH}x${GENERATED_DJVU_FIXTURE_HEIGHT}`,
    `${GENERATED_DJVU_FIXTURE_DPI}dpi.djvu`,
].join('-');
export interface IPdfAnnotationSummary {
    total: number;
    bySubtype: Record<string, number>;
}

export interface IPdfPageSnapshot {
    pageNumber: number;
    rotation: number;
    textSnippet: string;
}

export interface IFixtureAvailability {
    path: string | null;
    reason: string;
    required: boolean;
}

export interface IFixtureDescribeSelector {
    (name: string, fn: () => void): unknown;
    skip: IFixtureDescribeSelector;
}

interface IPathFixtureAvailabilityOptions {
    path: string;
    label: string;
    requiredEnvVar: string;
}

interface IDjvuFixtureAvailabilityOptions {
    devkitFixtureDir?: string;
    env?: NodeJS.ProcessEnv;
    generate?: boolean;
    generatedFixtureFactory?: () => string;
    trackedFixtureDir?: string;
}

const reportedMissingFixtureReasons = new Set<string>();

function isEnvFlagEnabled(envVar: string, env: NodeJS.ProcessEnv = process.env) {
    return env[envVar] === '1';
}

export function resolvePathFixtureAvailability(options: IPathFixtureAvailabilityOptions): IFixtureAvailability {
    const absolutePath = resolve(options.path);
    const required = isEnvFlagEnabled(options.requiredEnvVar);

    if (!existsSync(absolutePath)) {
        return {
            path: null,
            reason: `${options.label} fixture does not exist: ${absolutePath}`,
            required,
        };
    }

    if (!statSync(absolutePath).isFile()) {
        return {
            path: null,
            reason: `${options.label} fixture must point to a file: ${absolutePath}`,
            required,
        };
    }

    return {
        path: absolutePath,
        reason: `Using ${options.label} fixture: ${absolutePath}`,
        required,
    };
}

export function selectFixtureDescribe<TDescribe extends IFixtureDescribeSelector>(
    describeFn: TDescribe,
    fixture: IFixtureAvailability,
) {
    if (fixture.path) {
        return describeFn;
    }

    if (fixture.required) {
        throw new Error(`Required fixture missing: ${fixture.reason}`);
    }

    if (!reportedMissingFixtureReasons.has(fixture.reason)) {
        reportedMissingFixtureReasons.add(fixture.reason);
        console.info(`SKIPPED (fixture missing): ${fixture.reason}`);
    }

    return describeFn.skip;
}

function getFixtureDir(sessionName = getCurrentSessionName()) {
    const safeSessionName = sessionName.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
    return join(FIXTURE_ROOT_DIR, safeSessionName);
}

function ensureFixtureDir(sessionName = getCurrentSessionName()) {
    mkdirSync(getFixtureDir(sessionName), { recursive: true });
}

export function cleanupSessionFixtures(sessionName = getCurrentSessionName()) {
    rmSync(getFixtureDir(sessionName), {
        recursive: true,
        force: true,
    });
}

export function createFixturePath(filename: string) {
    ensureFixtureDir();
    return join(getFixtureDir(), filename);
}

export function copyProjectFixture(sourceFilename: string, targetFilename?: string) {
    ensureFixtureDir();
    const sourcePath = resolveProjectFixturePath(sourceFilename);
    const targetPath = join(getFixtureDir(), targetFilename ?? sourceFilename);
    writeFileSync(targetPath, readFileSync(sourcePath));
    return targetPath;
}

function resolveProjectFixturePath(sourceFilename: string) {
    const candidatePaths = [
        join(TRACKED_PROJECT_FIXTURE_DIR, sourceFilename),
        join(LEGACY_PROJECT_FIXTURE_DIR, sourceFilename),
    ];
    const sourcePath = candidatePaths.find(existsSync);

    if (sourcePath) {
        return sourcePath;
    }

    throw new Error(`Fixture does not exist in any known location: ${candidatePaths.join(', ')}`);
}

export function copyDevkitFixture(sourceRelativePath: string, targetFilename?: string) {
    ensureFixtureDir();
    const sourcePath = resolve(PROJECT_ROOT_FIXTURE_DIR, sourceRelativePath);
    if (!existsSync(sourcePath)) {
        throw new Error(`Fixture does not exist: ${sourcePath}`);
    }
    const targetPath = join(getFixtureDir(), targetFilename ?? basename(sourcePath));
    writeFileSync(targetPath, readFileSync(sourcePath));
    return targetPath;
}

export function resolveLargePdfFixturePath() {
    const overridePath = process.env[LARGE_PDF_FIXTURE_ENV_VAR]?.trim();
    const candidatePaths = overridePath
        ? [resolve(overridePath)]
        : [
            resolve(TRACKED_PROJECT_FIXTURE_DIR, DEFAULT_LARGE_PDF_FIXTURE),
            resolve(PROJECT_ROOT_FIXTURE_DIR, DEFAULT_LARGE_PDF_FIXTURE),
        ];
    const candidatePath = candidatePaths.find(candidate => existsSync(candidate) && statSync(candidate).isFile());

    if (!candidatePath) {
        return null;
    }
    return candidatePath;
}

export function resolveLargePdfFixtureAvailability(): IFixtureAvailability {
    const fixturePath = resolveLargePdfFixturePath();
    const required = isEnvFlagEnabled(LARGE_PDF_REQUIRE_ENV_VAR);

    if (fixturePath) {
        return {
            path: fixturePath,
            reason: `Using large PDF fixture: ${fixturePath}`,
            required,
        };
    }

    const overridePath = process.env[LARGE_PDF_FIXTURE_ENV_VAR]?.trim();
    return {
        path: null,
        reason: overridePath
            ? `${LARGE_PDF_FIXTURE_ENV_VAR} points to a missing fixture: ${resolve(overridePath)}`
            : `Large PDF fixture is not available. Set ${LARGE_PDF_FIXTURE_ENV_VAR}`
                + ` or place ${DEFAULT_LARGE_PDF_FIXTURE} under tests/fixtures/electron or .devkit.`,
        required,
    };
}

export function copyLargePdfFixture(targetFilename?: string) {
    const sourcePath = resolveLargePdfFixturePath();
    if (!sourcePath) {
        throw new Error(
            `Large PDF fixture is not available. Set ${LARGE_PDF_FIXTURE_ENV_VAR}`
            + ` or place ${DEFAULT_LARGE_PDF_FIXTURE} under tests/fixtures/electron or .devkit.`,
        );
    }
    ensureFixtureDir();
    const targetPath = join(getFixtureDir(), targetFilename ?? basename(sourcePath));
    copyFileSync(sourcePath, targetPath);
    return targetPath;
}

export async function createLinkOverlayFixturePdf(filename: string, url: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([
        612,
        792,
    ]);

    const text = 'Open external link';
    const size = 22;
    const x = 80;
    const y = 650;
    const textWidth = font.widthOfTextAtSize(text, size);

    page.drawText(text, {
        x,
        y,
        size,
        font,
        color: rgb(0.1, 0.22, 0.9),
    });

    const action = doc.context.obj({
        Type: PDFName.of('Action'),
        S: PDFName.of('URI'),
        URI: PDFString.of(url),
    });
    const actionRef = doc.context.register(action);

    const linkAnnotation = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Link'),
        Rect: [
            x,
            y - 4,
            x + textWidth,
            y + size + 6,
        ],
        Border: [
            0,
            0,
            0,
        ],
        A: actionRef,
    });
    const linkAnnotationRef = doc.context.register(linkAnnotation);
    page.node.set(PDFName.of('Annots'), doc.context.obj([linkAnnotationRef]));

    const bytes = await doc.save();
    writeFileSync(filePath, bytes);

    return filePath;
}

export async function createMultiPageTextFixturePdf(filename: string, pageCount = 3) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = doc.addPage([
            612,
            792,
        ]);
        page.drawText(`E2E Multi Page Fixture ${pageNumber}/${pageCount}`, {
            x: 70,
            y: 710,
            size: 24,
            font,
            color: rgb(0.13, 0.13, 0.13),
        });
        page.drawText(`Page ${pageNumber} sample text for annotations`, {
            x: 70,
            y: 660,
            size: 16,
            font,
            color: rgb(0.22, 0.22, 0.22),
        });
    }

    const bytes = await doc.save();
    writeFileSync(filePath, bytes);

    return filePath;
}

export function createPngFixture(filename: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGElEQVR4nGP8z8Dw'
        + 'n4GBgYmBgQEAOgoCEVxTeGsAAAAASUVORK5CYII=',
        'base64',
    );
    writeFileSync(filePath, bytes);
    return filePath;
}

export async function createBlankFixturePdf(filename: string, pageCount = 1) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);

    const doc = await PDFDocument.create();
    for (let pageNumber = 0; pageNumber < pageCount; pageNumber += 1) {
        doc.addPage([
            612,
            792,
        ]);
    }

    const bytes = await doc.save();
    writeFileSync(filePath, bytes);

    return filePath;
}

export async function createScannedTextFixturePdf(filename: string, text: string) {
    ensureFixtureDir();
    const filePath = join(getFixtureDir(), filename);
    const canvas = createCanvas(1200, 500);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111111';
    context.font = 'bold 72px sans-serif';
    context.fillText(text, 60, 270);

    const doc = await PDFDocument.create();
    const page = doc.addPage([
        600,
        250,
    ]);
    const image = await doc.embedPng(canvas.toBuffer('image/png'));
    page.drawImage(image, {
        x: 0,
        y: 0,
        width: 600,
        height: 250,
    });
    writeFileSync(filePath, await doc.save());
    return filePath;
}

export async function readPdfAnnotationSummary(filePath: string): Promise<IPdfAnnotationSummary> {
    const document = await openPdfWithLowVerbosity(filePath);

    const summary: IPdfAnnotationSummary = {
        total: 0,
        bySubtype: {},
    };

    try {
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const annotations = await page.getAnnotations();

            summary.total += annotations.length;
            for (const annotation of annotations) {
                const key = (annotation.subtype ?? 'Unknown').trim();
                summary.bySubtype[key] = (summary.bySubtype[key] ?? 0) + 1;
            }
        }
    } finally {
        await document.destroy();
    }

    return summary;
}

export async function readPdfPageSnapshots(filePath: string): Promise<IPdfPageSnapshot[]> {
    const document = await openPdfWithLowVerbosity(filePath);
    const pages: IPdfPageSnapshot[] = [];

    try {
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber);
            const textContent = await page.getTextContent();
            const snippet = textContent.items
                .map((item) => {
                    if (!('str' in item)) {
                        return '';
                    }
                    return String(item.str).trim();
                })
                .filter(Boolean)
                .slice(0, 8)
                .join(' ')
                .trim();

            pages.push({
                pageNumber,
                rotation: page.rotate ?? 0,
                textSnippet: snippet,
            });
        }
    } finally {
        await document.destroy();
    }

    return pages;
}

export function findDjvuFixturePath() {
    return resolveDjvuFixturePath().path;
}

export function isDjvuFixtureRequired(env: NodeJS.ProcessEnv = process.env) {
    return isEnvFlagEnabled(DJVU_REQUIRE_ENV_VAR, env);
}

function getGeneratedDjvuFixturePath() {
    return join(FIXTURE_ROOT_DIR, 'generated', GENERATED_DJVU_FIXTURE_FILENAME);
}

function createGeneratedDjvuPagePbm() {
    const rowBytes = Math.ceil(GENERATED_DJVU_FIXTURE_WIDTH / 8);
    const bitmap = Buffer.alloc(rowBytes * GENERATED_DJVU_FIXTURE_HEIGHT, 0);
    const setPixel = (x: number, y: number) => {
        if (
            x < 0
            || y < 0
            || x >= GENERATED_DJVU_FIXTURE_WIDTH
            || y >= GENERATED_DJVU_FIXTURE_HEIGHT
        ) {
            return;
        }
        const byteIndex = y * rowBytes + (x >> 3);
        bitmap[byteIndex] = (bitmap[byteIndex] ?? 0) | (0x80 >> (x & 7));
    };
    const drawHorizontalLine = (y: number, left: number, right: number) => {
        for (let x = left; x <= right; x += 1) {
            setPixel(x, y);
            setPixel(x, y + 1);
        }
    };
    const drawVerticalLine = (x: number, top: number, bottom: number) => {
        for (let y = top; y <= bottom; y += 1) {
            setPixel(x, y);
            setPixel(x + 1, y);
        }
    };

    drawHorizontalLine(96, 80, 1120);
    drawHorizontalLine(260, 160, 1040);
    drawHorizontalLine(580, 160, 1040);
    drawHorizontalLine(900, 160, 1040);
    drawHorizontalLine(1220, 160, 1040);
    drawVerticalLine(80, 96, 1500);
    drawVerticalLine(1120, 96, 1500);

    return Buffer.concat([
        Buffer.from(`P4\n${GENERATED_DJVU_FIXTURE_WIDTH} ${GENERATED_DJVU_FIXTURE_HEIGHT}\n`, 'ascii'),
        bitmap,
    ]);
}

function generateDjvuFixture(targetPath = getGeneratedDjvuFixturePath()) {
    if (existsSync(targetPath) && statSync(targetPath).isFile()) {
        return targetPath;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    const workDir = mkdtempSync(join(tmpdir(), 'evb-djvu-fixture-'));
    const pagePbmPath = join(workDir, 'page.pbm');
    const pageDjvuPath = join(workDir, 'page.djvu');
    const outputPath = join(workDir, 'document.djvu');

    try {
        writeFileSync(pagePbmPath, createGeneratedDjvuPagePbm());
        execFileSync('cjb2', [
            '-dpi',
            String(GENERATED_DJVU_FIXTURE_DPI),
            pagePbmPath,
            pageDjvuPath,
        ], { stdio: 'pipe' });
        execFileSync('djvm', [
            '-create',
            outputPath,
            ...Array.from({ length: GENERATED_DJVU_FIXTURE_PAGE_COUNT }, () => pageDjvuPath),
        ], { stdio: 'pipe' });

        const output = statSync(outputPath);
        if (!output.isFile() || output.size <= 0) {
            throw new Error(`Generated DjVu fixture is empty: ${outputPath}`);
        }

        try {
            renameSync(outputPath, targetPath);
        } catch (error) {
            if (existsSync(targetPath) && statSync(targetPath).isFile()) {
                return targetPath;
            }
            throw error;
        }
        return targetPath;
    } finally {
        rmSync(workDir, {
            recursive: true,
            force: true,
        });
    }
}

function describeGeneratedDjvuFixtureFailure(error: unknown) {
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    return String(error);
}

export function resolveDjvuFixturePath(options: IDjvuFixtureAvailabilityOptions = {}) {
    const env = options.env ?? process.env;
    const trackedFixtureDir = options.trackedFixtureDir ?? TRACKED_PROJECT_FIXTURE_DIR;
    const devkitFixtureDir = options.devkitFixtureDir ?? PROJECT_ROOT_FIXTURE_DIR;
    const required = isDjvuFixtureRequired(env);
    const overridePath = env[DJVU_FIXTURE_ENV_VAR]?.trim();
    if (overridePath) {
        const absoluteOverridePath = resolve(overridePath);
        if (!existsSync(absoluteOverridePath)) {
            return {
                path: null,
                reason: `${DJVU_FIXTURE_ENV_VAR} points to a missing path: ${absoluteOverridePath}`,
                required,
            };
        }
        if (!statSync(absoluteOverridePath).isFile()) {
            return {
                path: null,
                reason: `${DJVU_FIXTURE_ENV_VAR} must point to a file: ${absoluteOverridePath}`,
                required,
            };
        }
        if (!hasDjvuExtension(absoluteOverridePath)) {
            return {
                path: null,
                reason: `${DJVU_FIXTURE_ENV_VAR} must point to a .djvu or .djv file: ${absoluteOverridePath}`,
                required,
            };
        }
        return {
            path: absoluteOverridePath,
            reason: `Using ${DJVU_FIXTURE_ENV_VAR}: ${absoluteOverridePath}`,
            required,
        };
    }

    for (const candidatePath of [
        resolve(trackedFixtureDir, DEFAULT_DJVU_FIXTURE),
        resolve(devkitFixtureDir, DEFAULT_DJVU_FIXTURE),
    ]) {
        if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
            return {
                path: candidatePath,
                reason: `Using DjVu fixture: ${candidatePath}`,
                required,
            };
        }
    }

    if (options.generate !== false) {
        try {
            const generatedPath = options.generatedFixtureFactory
                ? options.generatedFixtureFactory()
                : generateDjvuFixture();
            if (!existsSync(generatedPath) || !statSync(generatedPath).isFile()) {
                throw new Error(`Generated DjVu fixture was not created: ${generatedPath}`);
            }
            if (!hasDjvuExtension(generatedPath)) {
                throw new Error(`Generated DjVu fixture must be a .djvu or .djv file: ${generatedPath}`);
            }
            return {
                path: generatedPath,
                reason: `Using generated DjVu fixture: ${generatedPath}`,
                required,
            };
        } catch (error) {
            return {
                path: null,
                reason: `Generated DjVu fixture is not available: ${describeGeneratedDjvuFixtureFailure(error)}`,
                required,
            };
        }
    }

    return {
        path: null,
        reason: `DjVu fixture is not available. Set ${DJVU_FIXTURE_ENV_VAR}`
            + ` or place ${DEFAULT_DJVU_FIXTURE} under tests/fixtures/electron or .devkit.`,
        required,
    };
}

function hasDjvuExtension(path: string) {
    const lowerPath = path.toLowerCase();
    return lowerPath.endsWith('.djvu') || lowerPath.endsWith('.djv');
}

async function openPdfWithLowVerbosity(filePath: string) {
    const data = new Uint8Array(readFileSync(filePath));
    return pdfjs.getDocument({
        data,
        ...createPdfjsNodeDocumentOptions(pdfjs),
    }).promise;
}
