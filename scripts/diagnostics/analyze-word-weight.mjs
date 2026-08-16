#!/usr/bin/env node

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
    mkdir,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    join,
    resolve,
} from 'node:path';
import {
    createCanvas,
    loadImage,
} from '@napi-rs/canvas';
import {loadGrayscaleImage} from './load-grayscale-image.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(process.argv[2] ?? '.');
const outputRenderDir = join(root, 'renders/output');
const sourceRenderDir = join(root, 'renders/source');
const ocrDir = join(root, 'ocr');
const cropDir = join(root, 'crops');
const metadataDir = join(root, 'conversion-evidence/native');
const INK_THRESHOLD = 160;

await mkdir(ocrDir, {recursive: true});
await mkdir(cropDir, {recursive: true});

function median(values) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function round(value, places = 4) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return null;
    }
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
}

function normalizeToken(text) {
    return text.normalize('NFKD').toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]/gu, '');
}

function levenshtein(a, b) {
    if (a === b) {
        return 0;
    }
    if (a.length === 0) {
        return b.length;
    }
    if (b.length === 0) {
        return a.length;
    }
    let previous = Array.from({length: b.length + 1}, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        previous = current;
    }
    return previous[b.length];
}

async function numberedPngs(directory) {
    const names = (await readdir(directory))
        .filter(name => /^page-\d+\.png$/u.test(name))
        .sort((a, b) => Number(a.match(/\d+/u)[0]) - Number(b.match(/\d+/u)[0]));
    return names.map(name => join(directory, name));
}

async function imageBitmap(path) {
    const bitmap = await loadGrayscaleImage(path);
    return {
        gray: bitmap.data,
        height: bitmap.height,
        width: bitmap.width,
    };
}

function parseTsv(tsv) {
    const rows = [];
    for (const line of tsv.split(/\r?\n/u).slice(1)) {
        const fields = line.split('\t');
        if (fields.length < 12 || fields[0] !== '5') continue;
        const [
            left,
            top,
            width,
            height,
            confidence,
        ] = [
            Number(fields[6]),
            Number(fields[7]),
            Number(fields[8]),
            Number(fields[9]),
            Number(fields[10]),
        ];
        const text = fields.slice(11).join('\t').trim();
        if (!text || ![
            left,
            top,
            width,
            height,
            confidence,
        ].every(Number.isFinite)) continue;
        rows.push({
            confidence,
            height,
            left,
            text,
            top,
            width,
        });
    }
    return rows;
}

async function ocr(path, kind, pageNumber) {
    const cachePath = join(ocrDir, `${kind}-page-${String(pageNumber).padStart(2, '0')}.tsv`);
    let tsv;
    try {
        tsv = await readFile(cachePath, 'utf8');
    } catch {
        const result = await execFileAsync('tesseract', [
            path,
            'stdout',
            '-l',
            'eng',
            '--psm',
            '3',
            'tsv',
        ], {
            maxBuffer: 32 * 1024 * 1024,
            timeout: 60_000,
        });
        tsv = result.stdout;
        await writeFile(cachePath, tsv, 'utf8');
    }
    return parseTsv(tsv);
}

function measureWord(bitmap, box) {
    const left = Math.max(0, Math.floor(box.left));
    const top = Math.max(0, Math.floor(box.top));
    const right = Math.min(bitmap.width, Math.ceil(box.left + box.width));
    const bottom = Math.min(bitmap.height, Math.ceil(box.top + box.height));
    const width = right - left;
    const height = bottom - top;
    if (width < 2 || height < 2 || width * height > 250_000) {
        return null;
    }

    const raw = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        const sourceOffset = (top + y) * bitmap.width + left;
        const targetOffset = y * width;
        for (let x = 0; x < width; x += 1) {
            raw[targetOffset + x] = bitmap.gray[sourceOffset + x] < INK_THRESHOLD ? 1 : 0;
        }
    }

    const seen = new Uint8Array(raw.length);
    const retained = new Uint8Array(raw.length);
    const queue = new Int32Array(raw.length);
    let componentCount = 0;
    let retainedInk = 0;
    const neighbors = [
        [
            -1,
            -1,
        ],
        [
            0,
            -1,
        ],
        [
            1,
            -1,
        ],
        [
            -1,
            0,
        ],
        [
            1,
            0,
        ],
        [
            -1,
            1,
        ],
        [
            0,
            1,
        ],
        [
            1,
            1,
        ],
    ];
    for (let seed = 0; seed < raw.length; seed += 1) {
        if (raw[seed] === 0 || seen[seed] !== 0) continue;
        let head = 0;
        let tail = 1;
        queue[0] = seed;
        seen[seed] = 1;
        let minX = seed % width;
        let maxX = minX;
        let minY = Math.floor(seed / width);
        let maxY = minY;
        while (head < tail) {
            const index = queue[head++];
            const x = index % width;
            const y = Math.floor(index / width);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            for (const [
                dx,
                dy,
            ] of neighbors) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                const next = ny * width + nx;
                if (raw[next] === 0 || seen[next] !== 0) continue;
                seen[next] = 1;
                queue[tail++] = next;
            }
        }
        const componentWidth = maxX - minX + 1;
        const componentHeight = maxY - minY + 1;
        const isRule = (
            (componentWidth >= width * 0.82 && componentHeight <= 2)
            || (componentHeight >= height * 0.82 && componentWidth <= 2)
        );
        if (tail < 2 || isRule) continue;
        componentCount += 1;
        retainedInk += tail;
        for (let index = 0; index < tail; index += 1) retained[queue[index]] = 1;
    }
    if (retainedInk < 8 || componentCount === 0) {
        return null;
    }

    const paddedWidth = width + 2;
    const paddedHeight = height + 2;
    const distance = new Uint16Array(paddedWidth * paddedHeight);
    const large = 30_000;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (retained[y * width + x] !== 0) distance[(y + 1) * paddedWidth + x + 1] = large;
        }
    }
    for (let y = 1; y <= height; y += 1) {
        for (let x = 1; x <= width; x += 1) {
            const index = y * paddedWidth + x;
            if (distance[index] === 0) continue;
            distance[index] = Math.min(
                distance[index],
                distance[index - 1] + 3,
                distance[index - paddedWidth] + 3,
                distance[index - paddedWidth - 1] + 4,
                distance[index - paddedWidth + 1] + 4,
            );
        }
    }
    for (let y = height; y >= 1; y -= 1) {
        for (let x = width; x >= 1; x -= 1) {
            const index = y * paddedWidth + x;
            if (distance[index] === 0) continue;
            distance[index] = Math.min(
                distance[index],
                distance[index + 1] + 3,
                distance[index + paddedWidth] + 3,
                distance[index + paddedWidth + 1] + 4,
                distance[index + paddedWidth - 1] + 4,
            );
        }
    }
    let distanceSum = 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (retained[y * width + x] !== 0) {
                distanceSum += distance[(y + 1) * paddedWidth + x + 1] / 3;
            }
        }
    }
    const meanDistancePx = distanceSum / retainedInk;
    return {
        bbox: {
            height,
            left,
            top,
            width,
        },
        componentCount,
        fillFraction: retainedInk / (width * height),
        inkPixels: retainedInk,
        meanDistancePx,
        strokeThicknessProxyPx: 4 * meanDistancePx,
    };
}

function eligibleGroup(words) {
    const base = words.filter(word => (
        word.measure !== null
        && word.confidence >= 20
        && word.normalized.length >= 2
        && word.normalized.length <= 40
        && /(?:\p{L}.*){2}/u.test(word.normalized)
        && word.measure.fillFraction <= 0.72
        && word.measure.inkPixels >= 10
    ));
    const medianHeight = median(base.map(word => word.measure.bbox.height));
    if (medianHeight === null) {
        return {
            medianHeight: null,
            medianThickness: null,
            words: [],
        };
    }
    const eligible = base.filter(word => (
        word.measure.bbox.height >= Math.max(6, medianHeight * 0.62)
        && word.measure.bbox.height <= Math.min(60, medianHeight * 1.62)
        && word.measure.bbox.width >= 4
        && word.measure.bbox.width <= 500
    ));
    const medianThickness = median(eligible.map(word => word.measure.strokeThicknessProxyPx));
    return {
        medianHeight,
        medianThickness,
        words: eligible,
    };
}

async function analyzeImage(path, kind, pageNumber) {
    const bitmap = await imageBitmap(path);
    const boxes = await ocr(path, kind, pageNumber);
    const words = boxes.map(box => ({
        ...box,
        measure: measureWord(bitmap, box),
        normalized: normalizeToken(box.text),
    })).filter(word => word.measure !== null);
    return {
        bitmap,
        path,
        words,
    };
}

function bestSourceMatch(candidate, sourceWords, outputHeight, sourceHeight) {
    const exact = sourceWords.filter(word => word.normalized === candidate.normalized);
    let pool = exact;
    let matchType = 'exact';
    if (pool.length === 0 && candidate.normalized.length >= 4) {
        const maximumDistance = Math.max(1, Math.floor(candidate.normalized.length * 0.2));
        pool = sourceWords.filter(word => (
            Math.abs(word.normalized.length - candidate.normalized.length) <= maximumDistance
            && levenshtein(word.normalized, candidate.normalized) <= maximumDistance
        ));
        matchType = 'fuzzy';
    }
    if (pool.length === 0) {
        return null;
    }
    const outputY = (candidate.measure.bbox.top + candidate.measure.bbox.height / 2) / outputHeight;
    return {
        matchType,
        word: [...pool].sort((a, b) => {
            const ay = (a.measure.bbox.top + a.measure.bbox.height / 2) / sourceHeight;
            const by = (b.measure.bbox.top + b.measure.bbox.height / 2) / sourceHeight;
            return Math.abs(ay - outputY) - Math.abs(by - outputY);
        })[0],
    };
}

async function saveCrop(imagePath, bbox, targetPath) {
    const image = await loadImage(imagePath);
    const padding = Math.max(6, Math.round(bbox.height * 0.35));
    const left = Math.max(0, bbox.left - padding);
    const top = Math.max(0, bbox.top - padding);
    const right = Math.min(image.width, bbox.left + bbox.width + padding);
    const bottom = Math.min(image.height, bbox.top + bbox.height + padding);
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    const canvas = createCanvas(width * 2, height * 2);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(image, left, top, width, height, 0, 0, width * 2, height * 2);
    await writeFile(targetPath, canvas.toBuffer('image/png'));
    return {
        height: height * 2,
        width: width * 2,
    };
}

async function savePair(outputCropPath, sourceCropPath, targetPath) {
    const [
        outputImage,
        sourceImage,
    ] = await Promise.all([
        loadImage(outputCropPath),
        loadImage(sourceCropPath),
    ]);
    const gap = 12;
    const height = Math.max(outputImage.height, sourceImage.height);
    const canvas = createCanvas(outputImage.width + sourceImage.width + gap, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(outputImage, 0, Math.floor((height - outputImage.height) / 2));
    context.fillStyle = '#888';
    context.fillRect(outputImage.width, 0, gap, height);
    context.drawImage(sourceImage, outputImage.width + gap, Math.floor((height - sourceImage.height) / 2));
    await writeFile(targetPath, canvas.toBuffer('image/png'));
}

async function saveContactSheet(items, targetPath) {
    const images = await Promise.all(items.map(item => loadImage(item.pairCrop)));
    const gap = 12;
    const width = Math.max(...images.map(image => image.width)) + gap * 2;
    const height = images.reduce((sum, image) => sum + image.height, 0) + gap * (images.length + 1);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    let top = gap;
    for (const image of images) {
        context.drawImage(image, gap, top);
        top += image.height + gap;
    }
    await writeFile(targetPath, canvas.toBuffer('image/png'));
}

const outputPaths = await numberedPngs(outputRenderDir);
const sourcePaths = await numberedPngs(sourceRenderDir);
if (outputPaths.length !== 20 || sourcePaths.length !== 10) {
    throw new Error(`Expected 20 output and 10 source renders; found ${outputPaths.length} and ${sourcePaths.length}`);
}

const sourceAnalyses = [];
for (let page = 1; page <= sourcePaths.length; page += 1) {
    sourceAnalyses.push(await analyzeImage(sourcePaths[page - 1], 'source', page));
}

const sourceHalves = new Map();
for (let page = 1; page <= sourceAnalyses.length; page += 1) {
    const analysis = sourceAnalyses[page - 1];
    const leftMetadata = JSON.parse(await readFile(join(metadataDir, `clean-${page}-0.json`), 'utf8'));
    const cutX = analysis.bitmap.width * leftMetadata.cutterXPx / leftMetadata.inputWidthPx;
    for (const half of [
        'left',
        'right',
    ]) {
        const words = analysis.words.filter(word => {
            const center = word.measure.bbox.left + word.measure.bbox.width / 2;
            return half === 'left' ? center < cutX : center >= cutX;
        });
        sourceHalves.set(`${page}-${half}`, {
            analysis,
            ...eligibleGroup(words),
            rawWords: words,
        });
    }
}

const pageResults = [];
const candidates = [];
for (let outputPage = 1; outputPage <= outputPaths.length; outputPage += 1) {
    const analysis = await analyzeImage(outputPaths[outputPage - 1], 'output', outputPage);
    const group = eligibleGroup(analysis.words);
    const sourcePage = Math.ceil(outputPage / 2);
    const half = outputPage % 2 === 1 ? 'left' : 'right';
    const sourceGroup = sourceHalves.get(`${sourcePage}-${half}`);
    for (const word of group.words) {
        const ratio = word.measure.strokeThicknessProxyPx / group.medianThickness;
        const matched = bestSourceMatch(
            word,
            sourceGroup.rawWords,
            analysis.bitmap.height,
            sourceGroup.analysis.bitmap.height,
        );
        const sourceRatio = matched && sourceGroup.medianThickness
            ? matched.word.measure.strokeThicknessProxyPx / sourceGroup.medianThickness
            : null;
        candidates.push({
            bbox: word.measure.bbox,
            confidence: word.confidence,
            half,
            matchType: matched?.matchType ?? null,
            normalized: word.normalized,
            outputPage,
            outputPath: analysis.path,
            pageMedianThicknessProxyPx: group.medianThickness,
            ratio,
            sourceBbox: matched?.word.measure.bbox ?? null,
            sourceMedianThicknessProxyPx: sourceGroup.medianThickness,
            sourcePage,
            sourcePath: sourceGroup.analysis.path,
            sourceRatio,
            sourceText: matched?.word.text ?? null,
            strokeThicknessProxyPx: word.measure.strokeThicknessProxyPx,
            text: word.text,
        });
    }
    pageResults.push({
        eligibleWordCount: group.words.length,
        half,
        medianHeightPx: round(group.medianHeight),
        medianThicknessProxyPx: round(group.medianThickness),
        outputPage,
        sourcePage,
    });
}

const top = candidates
    .filter(candidate => Number.isFinite(candidate.ratio))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 10);
const sourceAdjustedRanked = candidates
    .filter(candidate => (
        candidate.matchType === 'exact'
        && candidate.normalized.length >= 3
        && candidate.sourceRatio !== null
        && candidate.sourceRatio > 0
    ))
    .map(candidate => ({
        amplificationVsSource: candidate.ratio / candidate.sourceRatio,
        outputPage: candidate.outputPage,
        ratio: candidate.ratio,
        sourceRatio: candidate.sourceRatio,
        text: candidate.text,
    }))
    .sort((a, b) => b.amplificationVsSource - a.amplificationVsSource);
const flaggedTerms = candidates
    .filter(candidate => candidate.normalized.includes('fadinger') || candidate.normalized.includes('stylites'))
    .map(candidate => ({
        amplificationVsSource: candidate.sourceRatio
            ? candidate.ratio / candidate.sourceRatio
            : null,
        outputPage: candidate.outputPage,
        ratio: candidate.ratio,
        sourceRatio: candidate.sourceRatio,
        text: candidate.text,
    }));

for (let index = 0; index < top.length; index += 1) {
    const offender = top[index];
    const prefix = `rank-${String(index + 1).padStart(2, '0')}-p${String(offender.outputPage).padStart(2, '0')}`;
    const outputCropPath = join(cropDir, `${prefix}-output.png`);
    await saveCrop(offender.outputPath, offender.bbox, outputCropPath);
    offender.outputCrop = outputCropPath;
    if (offender.sourceBbox) {
        const sourceCropPath = join(cropDir, `${prefix}-source.png`);
        await saveCrop(offender.sourcePath, offender.sourceBbox, sourceCropPath);
        offender.sourceCrop = sourceCropPath;
        const pairPath = join(cropDir, `${prefix}-pair-output-left-source-right.png`);
        await savePair(outputCropPath, sourceCropPath, pairPath);
        offender.pairCrop = pairPath;
    }
    offender.ratio = round(offender.ratio);
    offender.sourceRatio = round(offender.sourceRatio);
    offender.amplificationVsSource = offender.sourceRatio
        ? round(offender.ratio / offender.sourceRatio)
        : null;
    offender.pageMedianThicknessProxyPx = round(offender.pageMedianThicknessProxyPx);
    offender.sourceMedianThicknessProxyPx = round(offender.sourceMedianThicknessProxyPx);
    offender.strokeThicknessProxyPx = round(offender.strokeThicknessProxyPx);
}
// An offender with no source match has no pair crop; the sheet must not take the whole
// run down with it, because the results file is still unwritten at this point.
const pairedTop = top.filter(item => item.pairCrop);
const pairSheetPath = join(root, 'top-10-pairs-contact-sheet.png');
// Drop any sheet from an earlier run first, so a skipped render cannot leave a stale
// image sitting next to fresh results as if it belonged to them.
await rm(pairSheetPath, {force: true});
if (pairedTop.length > 0) {
    await saveContactSheet(pairedTop, pairSheetPath);
}

const matchedTop = top.filter(item => item.amplificationVsSource !== null);
const result = {
    generatedAt: new Date().toISOString(),
    method: {
        analysisDpi: 150,
        cropScale: 2,
        grouping: 'Tesseract word boxes with 8-connected ink components retained inside each word cluster',
        inkThreshold: INK_THRESHOLD,
        pageMedianPopulation: 'OCR words with >=2 normalized characters, confidence >=20, plausible fill, and height within 0.62x..1.62x of the page/half median OCR word height',
        strokeThicknessProxy: '4 x mean 3-4 chamfer distance of retained word-cluster ink pixels to background',
    },
    outputPageCount: outputPaths.length,
    pageResults,
    sourcePageCount: sourcePaths.length,
    summary: {
        matchedTopCount: matchedTop.length,
        maximumOutputToPageMedianRatio: round(Math.max(...top.map(item => item.ratio))),
        maximumSourceAdjustedAmplification: sourceAdjustedRanked.length > 0
            ? round(sourceAdjustedRanked[0].amplificationVsSource)
            : null,
        outputWordsAbove10Percent: candidates.filter(item => item.ratio > 1.1).length,
        outputWordsAbove20Percent: candidates.filter(item => item.ratio > 1.2).length,
        reliableMatchedWords: sourceAdjustedRanked.length,
        sourceAdjustedWordsAbove10Percent: sourceAdjustedRanked.filter(item => item.amplificationVsSource > 1.1).length,
        sourceAdjustedWordsAbove20Percent: sourceAdjustedRanked.filter(item => item.amplificationVsSource > 1.2).length,
        totalEligibleOutputWords: candidates.length,
    },
    sourceAdjustedTop: sourceAdjustedRanked.slice(0, 10).map(item => ({
        amplificationVsSource: round(item.amplificationVsSource),
        outputPage: item.outputPage,
        ratio: round(item.ratio),
        sourceRatio: round(item.sourceRatio),
        text: item.text,
    })),
    flaggedTerms: flaggedTerms.map(item => ({
        amplificationVsSource: round(item.amplificationVsSource),
        outputPage: item.outputPage,
        ratio: round(item.ratio),
        sourceRatio: round(item.sourceRatio),
        text: item.text,
    })),
    topOffenders: top.map(item => ({
        amplificationVsSource: item.amplificationVsSource,
        bbox: item.bbox,
        half: item.half,
        matchType: item.matchType,
        outputCrop: item.outputCrop,
        outputPage: item.outputPage,
        pairCrop: item.pairCrop ?? null,
        pageMedianThicknessProxyPx: item.pageMedianThicknessProxyPx,
        ratio: item.ratio,
        sourceCrop: item.sourceCrop ?? null,
        sourcePage: item.sourcePage,
        sourceRatio: item.sourceRatio,
        sourceText: item.sourceText,
        strokeThicknessProxyPx: item.strokeThicknessProxyPx,
        text: item.text,
    })),
};

await writeFile(join(root, 'word-weight-results.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify(result.summary, null, 2) + '\n');
