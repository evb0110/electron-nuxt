#!/usr/bin/env node

import {
    mkdir,
    open,
} from 'node:fs/promises';
import {
    dirname,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_XLARGE_VIEWER_PAGE_COUNT = 138_000;
export const DEFAULT_XLARGE_VIEWER_OUTLINE_COUNT = 10_001;
export const DEFAULT_XLARGE_VIEWER_FIXTURE_BYTES = 513 * 1024 * 1024;
export const XLARGE_VIEWER_PAGE_TREE_FANOUT = 256;

const WRITE_BUFFER_BYTES = 1024 * 1024;

function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return parsed;
}

function readArgument(name) {
    const prefix = `--${name}=`;
    return process.argv.slice(2).find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}

function padXrefOffset(offset) {
    const value = String(offset);
    if (value.length > 10) {
        throw new Error(`Classic PDF xref offset exceeds ten digits: ${value}`);
    }
    return value.padStart(10, '0');
}

function outlineDestinationPage(index, outlineCount, pageCount) {
    if (outlineCount === 1) {
        return 1;
    }
    return Math.round(index * (pageCount - 1) / (outlineCount - 1)) + 1;
}

class BufferedPdfWriter {
    #buffer = '';
    #handle;
    #offset = 0;

    constructor(handle) {
        this.#handle = handle;
    }

    get offset() {
        return this.#offset;
    }

    async write(value) {
        this.#buffer += value;
        this.#offset += Buffer.byteLength(value, 'ascii');
        if (this.#buffer.length >= WRITE_BUFFER_BYTES) {
            await this.flush();
        }
    }

    async flush() {
        if (!this.#buffer) {
            return;
        }
        await this.#handle.write(Buffer.from(this.#buffer, 'ascii'));
        this.#buffer = '';
    }
}

export async function generateXlargeViewerAcceptanceFixture({
    outputPath,
    outlineCount = DEFAULT_XLARGE_VIEWER_OUTLINE_COUNT,
    pageCount = DEFAULT_XLARGE_VIEWER_PAGE_COUNT,
    targetBytes = DEFAULT_XLARGE_VIEWER_FIXTURE_BYTES,
}) {
    if (!outputPath) {
        throw new Error('outputPath is required');
    }
    const admittedPageCount = parsePositiveInteger(pageCount, 'pageCount');
    const admittedOutlineCount = parsePositiveInteger(outlineCount, 'outlineCount');
    const admittedTargetBytes = parsePositiveInteger(targetBytes, 'targetBytes');
    const leafCount = Math.ceil(admittedPageCount / XLARGE_VIEWER_PAGE_TREE_FANOUT);
    const firstLeafObject = 4;
    const firstPageObject = firstLeafObject + leafCount;
    const outlinesObject = firstPageObject + admittedPageCount;
    const firstOutlineItemObject = outlinesObject + 1;
    const objectCount = firstOutlineItemObject + admittedOutlineCount - 1;
    const offsets = new Array(objectCount + 1).fill(0);
    const absoluteOutputPath = resolve(outputPath);

    await mkdir(dirname(absoluteOutputPath), {recursive: true});
    const handle = await open(absoluteOutputPath, 'w');
    const writer = new BufferedPdfWriter(handle);

    async function writeObject(objectNumber, body) {
        offsets[objectNumber] = writer.offset;
        await writer.write(`${String(objectNumber)} 0 obj\n${body}\nendobj\n`);
    }

    try {
        await writer.write('%PDF-1.7\n%EVB deterministic xlarge viewer acceptance fixture\n');
        await writeObject(1, `<< /Type /Catalog /Pages 2 0 R /Outlines ${String(outlinesObject)} 0 R /PageMode /UseOutlines >>`);
        const rootKids = Array.from({length: leafCount}, (_, index) => (
            `${String(firstLeafObject + index)} 0 R`
        )).join(' ');
        await writeObject(2, `<< /Type /Pages /Count ${String(admittedPageCount)} /Kids [${rootKids}] >>`);
        const pageContent = '0 0 0 rg 8 8 8 8 re f';
        await writeObject(
            3,
            `<< /Length ${String(Buffer.byteLength(pageContent, 'ascii'))} >>\nstream\n${pageContent}\nendstream`,
        );

        for (let leafIndex = 0; leafIndex < leafCount; leafIndex += 1) {
            const firstPageIndex = leafIndex * XLARGE_VIEWER_PAGE_TREE_FANOUT;
            const pagesInLeaf = Math.min(
                XLARGE_VIEWER_PAGE_TREE_FANOUT,
                admittedPageCount - firstPageIndex,
            );
            const kids = Array.from({length: pagesInLeaf}, (_, pageOffset) => (
                `${String(firstPageObject + firstPageIndex + pageOffset)} 0 R`
            )).join(' ');
            await writeObject(
                firstLeafObject + leafIndex,
                `<< /Type /Pages /Parent 2 0 R /Count ${String(pagesInLeaf)} /Kids [${kids}] >>`,
            );
        }

        for (let pageIndex = 0; pageIndex < admittedPageCount; pageIndex += 1) {
            const parentObject = firstLeafObject
                + Math.floor(pageIndex / XLARGE_VIEWER_PAGE_TREE_FANOUT);
            await writeObject(
                firstPageObject + pageIndex,
                `<< /Type /Page /Parent ${String(parentObject)} 0 R /MediaBox [0 0 64 64] /Resources <<>> /Contents 3 0 R >>`,
            );
        }

        await writeObject(
            outlinesObject,
            `<< /Type /Outlines /First ${String(firstOutlineItemObject)} 0 R /Last ${String(objectCount)} 0 R /Count ${String(admittedOutlineCount)} >>`,
        );
        for (let outlineIndex = 0; outlineIndex < admittedOutlineCount; outlineIndex += 1) {
            const objectNumber = firstOutlineItemObject + outlineIndex;
            const pageNumber = outlineDestinationPage(
                outlineIndex,
                admittedOutlineCount,
                admittedPageCount,
            );
            const pageObject = firstPageObject + pageNumber - 1;
            const previous = outlineIndex > 0 ? ` /Prev ${String(objectNumber - 1)} 0 R` : '';
            const next = outlineIndex + 1 < admittedOutlineCount
                ? ` /Next ${String(objectNumber + 1)} 0 R`
                : '';
            const title = `Scale Outline ${String(outlineIndex).padStart(5, '0')}`;
            await writeObject(
                objectNumber,
                `<< /Title (${title}) /Parent ${String(outlinesObject)} 0 R${previous}${next} /Dest [${String(pageObject)} 0 R /Fit] >>`,
            );
        }

        const xrefOffset = writer.offset;
        await writer.write(`xref\n0 ${String(objectCount + 1)}\n`);
        await writer.write('0000000000 65535 f \n');
        for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
            await writer.write(`${padXrefOffset(offsets[objectNumber])} 00000 n \n`);
        }
        const finalTrailer = `\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
        await writer.write(`trailer\n<< /Size ${String(objectCount + 1)} /Root 1 0 R >>${finalTrailer}`);
        await writer.flush();
        if (admittedTargetBytes < writer.offset + Buffer.byteLength(finalTrailer, 'ascii')) {
            throw new Error(
                `targetBytes must be at least ${String(writer.offset + Buffer.byteLength(finalTrailer, 'ascii'))}`,
            );
        }
        if (admittedTargetBytes > writer.offset) {
            const trailerBuffer = Buffer.from(finalTrailer, 'ascii');
            await handle.truncate(admittedTargetBytes);
            await handle.write(
                trailerBuffer,
                0,
                trailerBuffer.byteLength,
                admittedTargetBytes - trailerBuffer.byteLength,
            );
        }
    } finally {
        await handle.close();
    }

    return absoluteOutputPath;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    const outputPath = readArgument('output');
    if (!outputPath) {
        throw new Error(
            'Usage: node scripts/generate-xlarge-viewer-acceptance-fixture.mjs '
            + '--output=<path> [--pages=138000] [--outlines=10001] [--bytes=537919488]',
        );
    }
    const generatedPath = await generateXlargeViewerAcceptanceFixture({
        outputPath,
        outlineCount: parsePositiveInteger(
            readArgument('outlines') ?? DEFAULT_XLARGE_VIEWER_OUTLINE_COUNT,
            'outlines',
        ),
        pageCount: parsePositiveInteger(
            readArgument('pages') ?? DEFAULT_XLARGE_VIEWER_PAGE_COUNT,
            'pages',
        ),
        targetBytes: parsePositiveInteger(
            readArgument('bytes') ?? DEFAULT_XLARGE_VIEWER_FIXTURE_BYTES,
            'bytes',
        ),
    });
    process.stdout.write(`${generatedPath}\n`);
}
