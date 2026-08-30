#!/usr/bin/env node

import {
    mkdir,
    mkdtemp,
    open,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
    resolve,
} from 'node:path';

const DEFAULT_PAGE_COUNT = 138_000;
const PAGES_PER_TREE_NODE = 256;
const OFFSET_BYTES = 8;
const OFFSET_READ_BATCH = 4_096;

function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new RangeError(`${label} must be a positive safe integer`);
    }
    return parsed;
}

function parseArguments(argv) {
    let outputPath = null;
    let pageCount = DEFAULT_PAGE_COUNT;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--pages') {
            pageCount = parsePositiveInteger(argv[index + 1], '--pages');
            index += 1;
            continue;
        }
        if (argument?.startsWith('--pages=')) {
            pageCount = parsePositiveInteger(argument.slice('--pages='.length), '--pages');
            continue;
        }
        if (argument?.startsWith('-')) {
            throw new Error(`Unknown option: ${argument}`);
        }
        if (outputPath !== null) {
            throw new Error('Expected one output PDF path');
        }
        outputPath = resolve(argument);
    }
    if (outputPath === null) {
        throw new Error('Usage: generate-scan-cleanup-xlarge-fixture.mjs [--pages N] <output.pdf>');
    }
    return {
        outputPath,
        pageCount,
    };
}

async function generateFixture({
    outputPath,
    pageCount,
}) {
    const leafCount = Math.ceil(pageCount / PAGES_PER_TREE_NODE);
    const firstLeafObject = 4;
    const firstPageObject = firstLeafObject + leafCount;
    const objectCount = firstPageObject + pageCount - 1;
    const scratch = await mkdtemp(join(tmpdir(), 'evb-scan-cleanup-xlarge-fixture-'));
    const offsetsPath = join(scratch, 'offsets.bin');
    let output;
    let offsets;
    let outputOffset = 0;

    async function write(text) {
        const bytes = Buffer.from(text, 'ascii');
        await output.write(bytes, 0, bytes.length, outputOffset);
        outputOffset += bytes.length;
    }

    async function beginObject(objectNumber) {
        const encodedOffset = Buffer.allocUnsafe(OFFSET_BYTES);
        encodedOffset.writeBigUInt64BE(BigInt(outputOffset));
        await offsets.write(encodedOffset, 0, OFFSET_BYTES, objectNumber * OFFSET_BYTES);
        await write(`${objectNumber} 0 obj\n`);
    }

    try {
        output = await open(outputPath, 'w');
        offsets = await open(offsetsPath, 'w+');
        await write('%PDF-1.7\n%EVBX\n');
        await beginObject(1);
        await write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

        await beginObject(2);
        await write('<< /Type /Pages /Count ');
        await write(String(pageCount));
        await write(' /Kids [');
        for (let leafIndex = 0; leafIndex < leafCount; leafIndex += 1) {
            await write(`${firstLeafObject + leafIndex} 0 R `);
        }
        await write('] >>\nendobj\n');

        await beginObject(3);
        const content = '0.4 g 0.25 0.25 0.5 0.5 re f\n';
        await write(`<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}endstream\nendobj\n`);

        for (let leafIndex = 0; leafIndex < leafCount; leafIndex += 1) {
            const firstPageIndex = leafIndex * PAGES_PER_TREE_NODE;
            const count = Math.min(PAGES_PER_TREE_NODE, pageCount - firstPageIndex);
            await beginObject(firstLeafObject + leafIndex);
            await write(`<< /Type /Pages /Parent 2 0 R /Count ${count} /Kids [`);
            for (let pageOffset = 0; pageOffset < count; pageOffset += 1) {
                await write(`${firstPageObject + firstPageIndex + pageOffset} 0 R `);
            }
            await write('] >>\nendobj\n');
        }

        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
            const leafObject = firstLeafObject + Math.floor(pageIndex / PAGES_PER_TREE_NODE);
            await beginObject(firstPageObject + pageIndex);
            await write(`<< /Type /Page /Parent ${leafObject} 0 R /MediaBox [0 0 1 1] /Resources << >> /Contents 3 0 R >>\nendobj\n`);
        }

        const xrefOffset = outputOffset;
        await write(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
        const encodedOffsets = Buffer.allocUnsafe(OFFSET_READ_BATCH * OFFSET_BYTES);
        for (let firstObject = 1; firstObject <= objectCount; firstObject += OFFSET_READ_BATCH) {
            const count = Math.min(OFFSET_READ_BATCH, objectCount - firstObject + 1);
            const {bytesRead} = await offsets.read(
                encodedOffsets,
                0,
                count * OFFSET_BYTES,
                firstObject * OFFSET_BYTES,
            );
            if (bytesRead !== count * OFFSET_BYTES) {
                throw new Error(`Missing xref offsets at object ${firstObject}`);
            }
            let xref = '';
            for (let offsetIndex = 0; offsetIndex < count; offsetIndex += 1) {
                const objectOffset = encodedOffsets.readBigUInt64BE(offsetIndex * OFFSET_BYTES);
                xref += `${objectOffset.toString().padStart(10, '0')} 00000 n \n`;
            }
            await write(xref);
        }
        await write(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    } finally {
        await Promise.allSettled([
            output?.close(),
            offsets?.close(),
        ]);
        await rm(scratch, {
            force: true,
            recursive: true,
        });
    }

    return {
        objectCount,
        outputBytes: outputOffset,
        outputPath,
        pageCount,
    };
}

const options = parseArguments(process.argv.slice(2));
await mkdir(dirname(options.outputPath), {recursive: true});
const result = await generateFixture(options);
process.stdout.write(`${JSON.stringify(result)}\n`);
