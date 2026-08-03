#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {inflateSync} from 'node:zlib';
import {
    mkdtemp,
    mkdir,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    basename,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDirectory = join(
    projectRoot,
    '.devkit/tasks/scan-cleanup/stage21-audit',
);
const defaultOutputPath = join(
    artifactDirectory,
    'scan-cleanup-word-loss-audit.json',
);
const CROP_SCALE = 2197 / 2261;
const ALIGNMENT_RADIUS_FULL_PX = 160;
const QUARTER_DOWNSAMPLE = 4;
const BROAD_DOWNSAMPLE = 16;
const MAX_BROAD_ALIGNMENT_SAMPLES = 50_000;
const MAX_QUARTER_ALIGNMENT_SAMPLES = 50_000;
const MAX_FULL_ALIGNMENT_SAMPLES = 8_000;
const BLACK_THRESHOLD = 128;

function scaleLabel(scale) {
    if (typeof scale === 'object') {
        return scale.label;
    }
    if (scale === 1) {
        return '1.0';
    }
    if (Math.abs(scale - CROP_SCALE) < 1e-9) {
        return '2197/2261';
    }
    return `dimension-fit(${scale.toFixed(6)})`;
}

function parseArgs(argv) {
    const options = {
        cleaned: null,
        from: null,
        minArea: 24,
        out: defaultOutputPath,
        source: null,
        to: null,
        workers: 4,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--' || argument === '') {
            continue;
        }
        if (argument === '--help' || argument === '-h') {
            console.log(`Usage: node scripts/diagnostics/scan-cleanup-word-loss-audit.mjs --source <pdf> --cleaned <pdf> [options]

Options:
  --source <pdf>       Source PDF with the original text smask
  --cleaned <pdf>      Cleaned MRC PDF to audit
  --from <page>        First PDF page (default: 1)
  --to <page>          Last PDF page (default: source page count)
  --out <json>         JSON report path (default: ${defaultOutputPath})
  --min-area <pixels>  Minimum source component area (default: 24)
  --workers <count>    Concurrent page workers (default: 4)`);
            return {
                ...options,
                help: true,
            };
        }
        const valueArguments = new Set([
            '--cleaned',
            '--from',
            '--min-area',
            '--out',
            '--source',
            '--to',
            '--workers',
        ]);
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
        } else if (argument === '--from' || argument === '--to') {
            options[argument.slice(2)] = parsePositiveInteger(value, argument);
        } else if (argument === '--min-area') {
            options.minArea = parsePositiveInteger(value, argument);
        } else if (argument === '--workers') {
            options.workers = parsePositiveInteger(value, argument);
        }
        index += 1;
    }
    if (!options.source || !options.cleaned) {
        throw new Error('Both --source and --cleaned are required');
    }
    return options;
}

function parsePositiveInteger(value, argument) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${argument} must be a positive integer`);
    }
    return parsed;
}

async function run(command, args) {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            env: process.env,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.on('error', rejectRun);
        child.on('close', code => {
            if (code !== 0) {
                const commandLine = [
                    command,
                    ...args,
                ].join(' ');
                rejectRun(new Error(
                    `${commandLine} exited with ${String(code)}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
                ));
                return;
            }
            resolveRun({
                stderr,
                stdout,
            });
        });
    });
}

function parsePdfImagesListing(text) {
    return text.split(/\r?\n/u).flatMap(line => {
        const parts = line.trim().split(/\s+/u);
        if (
            parts.length < 14
            || !/^\d+$/u.test(parts[0])
            || !/^\d+$/u.test(parts[1])
            || !/^\d+$/u.test(parts[3])
            || !/^\d+$/u.test(parts[4])
            || !/^\d+$/u.test(parts[7])
        ) {
            return [];
        }
        return [{
            bpc: Number(parts[7]),
            color: parts[5],
            encoding: parts[8],
            height: Number(parts[4]),
            num: Number(parts[1]),
            page: Number(parts[0]),
            type: parts[2],
            width: Number(parts[3]),
            xPpi: Number(parts[12]),
            yPpi: Number(parts[13]),
        }];
    });
}

function groupRowsByPage(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const pageRows = grouped.get(row.page) ?? [];
        pageRows.push(row);
        grouped.set(row.page, pageRows);
    }
    return grouped;
}

function selectSourceMaskRow(rows) {
    return rows
        .filter(row => row.type === 'smask' && row.bpc === 1)
        .sort((left, right) => right.width * right.height - left.width * left.height)[0]
        ?? null;
}

function selectCleanedInkRow(rows) {
    return rows
        .filter(row =>
            row.bpc === 1
            && (row.type === 'stencil' || row.type === 'image'),
        )
        .sort((left, right) => {
            if (left.type !== right.type) {
                return left.type === 'stencil' ? -1 : 1;
            }
            return right.width * right.height - left.width * left.height;
        })[0]
        ?? null;
}

function pngFileNumber(fileName) {
    const match = /-(\d+)\.png$/u.exec(fileName);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

async function extractPngMask({
    pageNumber,
    pdfPath,
    row,
    rows,
    role,
    workDirectory,
}) {
    const rowIndex = rows.indexOf(row);
    if (rowIndex < 0) {
        throw new Error(`Could not map ${role} image row on PDF page ${pageNumber}`);
    }
    const prefix = join(
        workDirectory,
        `${role}-page-${String(pageNumber)}-${String(row.num)}`,
    );
    await run('pdfimages', [
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-png',
        pdfPath,
        prefix,
    ]);
    const prefixName = basename(prefix);
    const extractedNames = (await readdir(workDirectory))
        .filter(name => name.startsWith(`${prefixName}-`) && name.endsWith('.png'))
        .sort((left, right) => pngFileNumber(left) - pngFileNumber(right));
    try {
        const extractedName = extractedNames[rowIndex];
        if (!extractedName) {
            throw new Error(
                `pdfimages did not produce ${role} row ${String(rowIndex)} on PDF page ${pageNumber}`,
            );
        }
        return decodePng(await readFile(join(workDirectory, extractedName)));
    } finally {
        await Promise.all(extractedNames.map(name =>
            rm(join(workDirectory, name), {force: true}),
        ));
    }
}

function decodePng(buffer) {
    const signature = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
    ]);
    if (buffer.subarray(0, signature.length).compare(signature) !== 0) {
        throw new Error('Invalid PNG signature');
    }
    let offset = signature.length;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlaceMethod = 0;
    const imageData = [];
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > buffer.length) {
            throw new Error('Truncated PNG chunk');
        }
        if (type === 'IHDR') {
            width = buffer.readUInt32BE(dataStart);
            height = buffer.readUInt32BE(dataStart + 4);
            bitDepth = buffer[dataStart + 8];
            colorType = buffer[dataStart + 9];
            interlaceMethod = buffer[dataStart + 12];
        } else if (type === 'IDAT') {
            imageData.push(buffer.subarray(dataStart, dataEnd));
        } else if (type === 'IEND') {
            break;
        }
        offset = dataEnd + 4;
    }
    if (
        width <= 0
        || height <= 0
        || colorType !== 0
        || (bitDepth !== 1 && bitDepth !== 8)
        || interlaceMethod !== 0
    ) {
        throw new Error(
            `Unsupported grayscale PNG: ${String(width)}x${String(height)}, bit depth ${String(bitDepth)}, color type ${String(colorType)}, interlace ${String(interlaceMethod)}`,
        );
    }
    const rowBytes = Math.ceil(width * bitDepth / 8);
    const bytesPerPixel = 1;
    const inflated = inflateSync(Buffer.concat(imageData));
    const pixels = new Uint8Array(width * height);
    const previous = Buffer.alloc(rowBytes);
    const current = Buffer.alloc(rowBytes);
    let inputOffset = 0;
    let darkPixelCount = 0;
    for (let y = 0; y < height; y += 1) {
        if (inputOffset + rowBytes + 1 > inflated.length) {
            throw new Error('Truncated PNG image data');
        }
        const filter = inflated[inputOffset];
        inputOffset += 1;
        inflated.copy(current, 0, inputOffset, inputOffset + rowBytes);
        inputOffset += rowBytes;
        unfilterPngRow(current, previous, filter, bytesPerPixel);
        const outputOffset = y * width;
        if (bitDepth === 8) {
            for (let x = 0; x < width; x += 1) {
                if (current[x] < BLACK_THRESHOLD) {
                    pixels[outputOffset + x] = 1;
                    darkPixelCount += 1;
                }
            }
        } else {
            for (let x = 0; x < width; x += 1) {
                const sample = (current[x >> 3] >> (7 - (x & 7))) & 1;
                if (sample === 0) {
                    pixels[outputOffset + x] = 1;
                    darkPixelCount += 1;
                }
            }
        }
        current.copy(previous);
    }
    const totalPixels = width * height;
    const invertForeground = darkPixelCount > totalPixels / 2;
    if (invertForeground) {
        for (let index = 0; index < pixels.length; index += 1) {
            pixels[index] = pixels[index] ? 0 : 1;
        }
    }
    return {
        blackCount: invertForeground ? totalPixels - darkPixelCount : darkPixelCount,
        height,
        inverted: invertForeground,
        pixels,
        width,
    };
}

function unfilterPngRow(current, previous, filter, bytesPerPixel) {
    if (filter === 0) {
        return;
    }
    if (filter === 1) {
        for (let index = 0; index < current.length; index += 1) {
            const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
            current[index] = (current[index] + left) & 0xff;
        }
        return;
    }
    if (filter === 2) {
        for (let index = 0; index < current.length; index += 1) {
            current[index] = (current[index] + previous[index]) & 0xff;
        }
        return;
    }
    if (filter === 3) {
        for (let index = 0; index < current.length; index += 1) {
            const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
            const up = previous[index];
            current[index] = (current[index] + Math.floor((left + up) / 2)) & 0xff;
        }
        return;
    }
    if (filter === 4) {
        for (let index = 0; index < current.length; index += 1) {
            const left = index >= bytesPerPixel ? current[index - bytesPerPixel] : 0;
            const up = previous[index];
            const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
            current[index] = (current[index] + paethPredictor(left, up, upLeft)) & 0xff;
        }
        return;
    }
    throw new Error(`Unsupported PNG filter ${String(filter)}`);
}

function paethPredictor(left, up, upLeft) {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const upLeftDistance = Math.abs(estimate - upLeft);
    if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
        return left;
    }
    if (upDistance <= upLeftDistance) {
        return up;
    }
    return upLeft;
}

function makeBitmap(width, height, pixels) {
    let blackCount = 0;
    for (const pixel of pixels) {
        blackCount += pixel;
    }
    return {
        blackCount,
        height,
        pixels,
        width,
    };
}

function downsampleBitmap(bitmap, factor) {
    const width = Math.ceil(bitmap.width / factor);
    const height = Math.ceil(bitmap.height / factor);
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < bitmap.height; y += 1) {
        const targetY = Math.floor(y / factor);
        const sourceOffset = y * bitmap.width;
        const targetOffset = targetY * width;
        for (let x = 0; x < bitmap.width; x += 1) {
            if (bitmap.pixels[sourceOffset + x]) {
                pixels[targetOffset + Math.floor(x / factor)] = 1;
            }
        }
    }
    return makeBitmap(width, height, pixels);
}

function resizeBitmap(bitmap, width, height, scaleX, scaleY = scaleX) {
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        const sourceY = Math.min(
            bitmap.height - 1,
            Math.max(0, Math.floor((y + 0.5) / scaleY - 0.5)),
        );
        const sourceOffset = sourceY * bitmap.width;
        const targetOffset = y * width;
        for (let x = 0; x < width; x += 1) {
            const sourceX = Math.min(
                bitmap.width - 1,
                Math.max(0, Math.floor((x + 0.5) / scaleX - 0.5)),
            );
            pixels[targetOffset + x] = bitmap.pixels[sourceOffset + sourceX];
        }
    }
    return makeBitmap(width, height, pixels);
}

function collectBlackRows(bitmap, maxSamples) {
    const stride = Math.max(1, Math.ceil(bitmap.blackCount / maxSamples));
    const rows = Array.from({length: bitmap.height}, () => []);
    let ordinal = 0;
    let sampleCount = 0;
    for (let y = 0; y < bitmap.height; y += 1) {
        const offset = y * bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            if (!bitmap.pixels[offset + x]) {
                continue;
            }
            if (ordinal % stride === 0) {
                rows[y].push(x);
                sampleCount += 1;
            }
            ordinal += 1;
        }
    }
    return {
        rows,
        sampleCount,
    };
}

function scoreRows(sourceRows, sourceWidth, target, targetWidth, dx, dy) {
    let overlap = 0;
    const sourceHeight = sourceRows.length;
    const targetHeight = target.length / targetWidth;
    const firstSourceX = Math.max(0, -dx);
    const lastSourceX = Math.min(sourceWidth, targetWidth - dx);
    for (let sourceY = 0; sourceY < sourceHeight; sourceY += 1) {
        const targetY = sourceY + dy;
        if (targetY < 0 || targetY >= targetHeight) {
            continue;
        }
        const sourceRow = sourceRows[sourceY];
        if (sourceRow.length === 0) {
            continue;
        }
        const targetOffset = targetY * targetWidth + dx;
        for (const sourceX of sourceRow) {
            if (
                sourceX >= firstSourceX
                && sourceX < lastSourceX
                && target[targetOffset + sourceX]
            ) {
                overlap += 1;
            }
        }
    }
    return overlap;
}

function preferCandidate(candidate, best, preferredDx, preferredDy) {
    if (candidate.score !== best.score) {
        return candidate.score > best.score;
    }
    const candidateDistance =
        Math.abs(candidate.dx - preferredDx) + Math.abs(candidate.dy - preferredDy);
    const bestDistance = Math.abs(best.dx - preferredDx) + Math.abs(best.dy - preferredDy);
    return candidateDistance < bestDistance;
}

function searchReverseRows({
    maxDx,
    maxDy,
    minDx,
    minDy,
    preferredDx,
    preferredDy,
    sourceRows,
    sourceWidth,
    step,
    target,
    targetWidth,
}) {
    let best = {
        dx: preferredDx,
        dy: preferredDy,
        score: -1,
    };
    for (let dy = minDy; dy <= maxDy; dy += step) {
        for (let dx = minDx; dx <= maxDx; dx += step) {
            const candidate = {
                dx,
                dy,
                score: scoreRows(sourceRows, sourceWidth, target, targetWidth, -dx, -dy),
            };
            if (preferCandidate(candidate, best, preferredDx, preferredDy)) {
                best = candidate;
            }
        }
    }
    return best;
}

function exactOverlap(source, target, dx, dy) {
    let overlap = 0;
    const targetHeight = target.height;
    for (let sourceY = 0; sourceY < source.height; sourceY += 1) {
        const targetY = sourceY + dy;
        if (targetY < 0 || targetY >= targetHeight) {
            continue;
        }
        const firstSourceX = Math.max(0, -dx);
        const lastSourceX = Math.min(source.width, target.width - dx);
        const sourceOffset = sourceY * source.width;
        const targetOffset = targetY * target.width + dx;
        for (let sourceX = firstSourceX; sourceX < lastSourceX; sourceX += 1) {
            if (source.pixels[sourceOffset + sourceX] && target.pixels[targetOffset + sourceX]) {
                overlap += 1;
            }
        }
    }
    return overlap;
}

function makeScaleMap(length, scale) {
    const mapped = new Int32Array(length);
    for (let index = 0; index < length; index += 1) {
        mapped[index] = Math.max(0, Math.floor((index + 0.5) * scale));
    }
    return mapped;
}

function collectMappedBlackPoints(source, scale, maxSamples) {
    const stride = Math.max(1, Math.ceil(source.blackCount / maxSamples));
    const capacity = Math.ceil(source.blackCount / stride);
    const xs = new Uint16Array(capacity);
    const ys = new Uint16Array(capacity);
    const xMap = makeScaleMap(source.width, scale);
    const yMap = makeScaleMap(source.height, scale);
    let ordinal = 0;
    let pointCount = 0;
    for (let y = 0; y < source.height; y += 1) {
        const offset = y * source.width;
        for (let x = 0; x < source.width; x += 1) {
            if (!source.pixels[offset + x]) {
                continue;
            }
            if (ordinal % stride === 0) {
                xs[pointCount] = xMap[x];
                ys[pointCount] = yMap[y];
                pointCount += 1;
            }
            ordinal += 1;
        }
    }
    return {
        count: pointCount,
        xs: xs.subarray(0, pointCount),
        ys: ys.subarray(0, pointCount),
    };
}

function scoreInverseMappedPoints(points, source, dx, dy, scaleX, scaleY) {
    let overlap = 0;
    for (let index = 0; index < points.count; index += 1) {
        const sourceX = Math.round((points.xs[index] - dx) / scaleX);
        const sourceY = Math.round((points.ys[index] - dy) / scaleY);
        if (
            sourceX >= 0
            && sourceX < source.width
            && sourceY >= 0
            && sourceY < source.height
            && source.pixels[sourceY * source.width + sourceX]
        ) {
            overlap += 1;
        }
    }
    return overlap;
}

function searchInverseMappedPoints({
    maxDx,
    maxDy,
    minDx,
    minDy,
    points,
    preferredDx,
    preferredDy,
    scaleX,
    scaleY,
    source,
}) {
    let best = {
        dx: preferredDx,
        dy: preferredDy,
        score: -1,
    };
    for (let dy = minDy; dy <= maxDy; dy += 1) {
        for (let dx = minDx; dx <= maxDx; dx += 1) {
            const candidate = {
                dx,
                dy,
                score: scoreInverseMappedPoints(points, source, dx, dy, scaleX, scaleY),
            };
            if (preferCandidate(candidate, best, preferredDx, preferredDy)) {
                best = candidate;
            }
        }
    }
    return best;
}

function makeAlignmentBitmap(source, minArea, collectComponents = false) {
    const maxAlignmentArea = 3_500;
    const maxAlignmentWidth = 180;
    const maxAlignmentHeight = 60;
    const minAlignmentDensity = 0.18;
    const visited = new Uint8Array(source.pixels.length);
    const pixels = new Uint8Array(source.pixels.length);
    const stack = [];
    const candidateComponents = [];
    const metricComponents = [];
    const plateRegions = [];
    const componentLabels = collectComponents
        ? new Int32Array(source.pixels.length)
        : null;
    let nextComponentId = 0;
    for (let start = 0; start < source.pixels.length; start += 1) {
        if (!source.pixels[start] || visited[start]) {
            continue;
        }
        stack.length = 0;
        stack.push(start);
        visited[start] = 1;
        nextComponentId += 1;
        const componentId = nextComponentId;
        let area = 0;
        let minX = source.width;
        let minY = source.height;
        let maxX = -1;
        let maxY = -1;
        let keepPixels = true;
        let componentPixels = [];
        while (stack.length > 0) {
            const current = stack.pop();
            const currentX = current % source.width;
            const currentY = Math.floor(current / source.width);
            area += 1;
            minX = Math.min(minX, currentX);
            minY = Math.min(minY, currentY);
            maxX = Math.max(maxX, currentX);
            maxY = Math.max(maxY, currentY);
            if (componentLabels) {
                componentLabels[current] = componentId;
            }
            if (keepPixels) {
                componentPixels.push(current);
            }
            if (
                area > maxAlignmentArea
                || maxX - minX + 1 > maxAlignmentWidth
                || maxY - minY + 1 > maxAlignmentHeight
            ) {
                keepPixels = false;
                componentPixels = [];
            }
            for (let neighborY = Math.max(0, currentY - 1); neighborY <= Math.min(source.height - 1, currentY + 1); neighborY += 1) {
                const neighborOffset = neighborY * source.width;
                for (let neighborX = Math.max(0, currentX - 1); neighborX <= Math.min(source.width - 1, currentX + 1); neighborX += 1) {
                    const neighbor = neighborOffset + neighborX;
                    if (source.pixels[neighbor] && !visited[neighbor]) {
                        visited[neighbor] = 1;
                        stack.push(neighbor);
                    }
                }
            }
        }
        const componentWidth = maxX - minX + 1;
        const componentHeight = maxY - minY + 1;
        if (
            componentHeight > 220
            || componentHeight > 40
            || (componentWidth > 500 && componentHeight > 50)
        ) {
            const padding = 160;
            const regionX = Math.max(0, minX - padding);
            const regionY = Math.max(0, minY - padding);
            const regionRight = Math.min(source.width, maxX + 1 + padding);
            const regionBottom = Math.min(source.height, maxY + 1 + padding);
            plateRegions.push({
                height: regionBottom - regionY,
                width: regionRight - regionX,
                x: regionX,
                y: regionY,
            });
        }
        if (
            keepPixels
            && area >= minArea
            && componentHeight >= 8
            && area / (componentWidth * componentHeight) >= minAlignmentDensity
        ) {
            candidateComponents.push({
                height: componentHeight,
                pixels: componentPixels,
                width: componentWidth,
                x: minX,
                y: minY,
            });
        }
        if (
            collectComponents
            && area >= minArea
            && componentHeight >= 8
            && componentHeight <= 220
        ) {
            metricComponents.push({
                area,
                height: componentHeight,
                id: componentId,
                width: componentWidth,
                x: minX,
                y: minY,
            });
        }
    }
    for (const component of candidateComponents) {
        const centerX = component.x + component.width / 2;
        const centerY = component.y + component.height / 2;
        if (plateRegions.some(region =>
            centerX >= region.x
            && centerX < region.x + region.width
            && centerY >= region.y
            && centerY < region.y + region.height,
        )) {
            continue;
        }
        for (const pixelIndex of component.pixels) {
            pixels[pixelIndex] = 1;
        }
    }
    const alignment = makeBitmap(source.width, source.height, pixels);
    return {
        bitmap: alignment.blackCount === 0 ? source : alignment,
        componentCount: nextComponentId,
        componentLabels,
        components: metricComponents,
        plateRegions,
    };
}

function alignAtScale(
    source,
    cleaned,
    scale,
    alignmentSource = source,
    alignmentCleaned = cleaned,
) {
    const scaleX = typeof scale === 'number' ? scale : scale.x;
    const scaleY = typeof scale === 'number' ? scale : scale.y;
    const sourceQuarter = downsampleBitmap(alignmentSource, QUARTER_DOWNSAMPLE);
    const cleanedQuarter = downsampleBitmap(alignmentCleaned, QUARTER_DOWNSAMPLE);
    const scaledQuarter = scaleX === 1 && scaleY === 1
        ? sourceQuarter
        : resizeBitmap(
            sourceQuarter,
            Math.max(1, Math.ceil(alignmentSource.width * scaleX / QUARTER_DOWNSAMPLE)),
            Math.max(1, Math.ceil(alignmentSource.height * scaleY / QUARTER_DOWNSAMPLE)),
            scaleX,
            scaleY,
        );
    const sourceBroad = downsampleBitmap(scaledQuarter, BROAD_DOWNSAMPLE / QUARTER_DOWNSAMPLE);
    const cleanedBroad = downsampleBitmap(cleanedQuarter, BROAD_DOWNSAMPLE / QUARTER_DOWNSAMPLE);
    const broadRows = collectBlackRows(cleanedBroad, MAX_BROAD_ALIGNMENT_SAMPLES);
    const broadRadius = Math.ceil(ALIGNMENT_RADIUS_FULL_PX / BROAD_DOWNSAMPLE);
    const broad = searchReverseRows({
        maxDx: broadRadius,
        maxDy: broadRadius,
        minDx: -broadRadius,
        minDy: -broadRadius,
        preferredDx: 0,
        preferredDy: 0,
        sourceRows: broadRows.rows,
        sourceWidth: cleanedBroad.width,
        step: 2,
        target: sourceBroad.pixels,
        targetWidth: sourceBroad.width,
    });
    const quarterRows = collectBlackRows(cleanedQuarter, MAX_QUARTER_ALIGNMENT_SAMPLES);
    const quarterCenterDx = broad.dx * (BROAD_DOWNSAMPLE / QUARTER_DOWNSAMPLE);
    const quarterCenterDy = broad.dy * (BROAD_DOWNSAMPLE / QUARTER_DOWNSAMPLE);
    const quarter = searchReverseRows({
        maxDx: quarterCenterDx + 4,
        maxDy: quarterCenterDy + 4,
        minDx: quarterCenterDx - 4,
        minDy: quarterCenterDy - 4,
        preferredDx: quarterCenterDx,
        preferredDy: quarterCenterDy,
        sourceRows: quarterRows.rows,
        sourceWidth: cleanedQuarter.width,
        step: 1,
        target: scaledQuarter.pixels,
        targetWidth: scaledQuarter.width,
    });
    const fullPoints = collectMappedBlackPoints(alignmentCleaned, 1, MAX_FULL_ALIGNMENT_SAMPLES);
    const fullCenterDx = quarter.dx * QUARTER_DOWNSAMPLE;
    const fullCenterDy = quarter.dy * QUARTER_DOWNSAMPLE;
    const full = searchInverseMappedPoints({
        maxDx: fullCenterDx + 4,
        maxDy: fullCenterDy + 4,
        minDx: fullCenterDx - 4,
        minDy: fullCenterDy - 4,
        points: fullPoints,
        preferredDx: fullCenterDx,
        preferredDy: fullCenterDy,
        scaleX,
        scaleY,
        source: alignmentSource,
    });
    const quarterOverlap = exactOverlap(
        scaledQuarter,
        cleanedQuarter,
        quarter.dx,
        quarter.dy,
    );
    const quarterOverlapScore = scaledQuarter.blackCount === 0
        ? 0
        : quarterOverlap / scaledQuarter.blackCount;
    const fullOverlapScore = fullPoints.count === 0
        ? 0
        : full.score / fullPoints.count;
    return {
        broadDx: broad.dx,
        broadDy: broad.dy,
        dx: full.dx,
        dy: full.dy,
        fullOverlapScore,
        overlapScore: quarterOverlapScore,
        quarterDx: quarter.dx,
        quarterDy: quarter.dy,
        scale,
        scaleX,
        scaleY,
    };
}

function dilateOnePixel(bitmap) {
    const horizontal = new Uint8Array(bitmap.width * bitmap.height);
    for (let y = 0; y < bitmap.height; y += 1) {
        const offset = y * bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            horizontal[offset + x] = bitmap.pixels[offset + x]
                || (x > 0 && bitmap.pixels[offset + x - 1])
                || (x + 1 < bitmap.width && bitmap.pixels[offset + x + 1])
                ? 1
                : 0;
        }
    }
    const pixels = new Uint8Array(bitmap.width * bitmap.height);
    for (let y = 0; y < bitmap.height; y += 1) {
        const offset = y * bitmap.width;
        const previousOffset = offset - bitmap.width;
        const nextOffset = offset + bitmap.width;
        for (let x = 0; x < bitmap.width; x += 1) {
            pixels[offset + x] = horizontal[offset + x]
                || (y > 0 && horizontal[previousOffset + x])
                || (y + 1 < bitmap.height && horizontal[nextOffset + x])
                ? 1
                : 0;
        }
    }
    return {
        height: bitmap.height,
        pixels,
        width: bitmap.width,
    };
}

function analyzeComponents(
    source,
    cleanedDilated,
    alignment,
    minArea,
    plateRegions = [],
    sourceComponents = [],
    componentLabels = null,
    componentCount = 0,
) {
    const sourceWidth = source.width;
    const components = [];
    const dustArea = Math.max(minArea, 200);
    const eligibleComponents = [];
    const coveredPixelsByComponent = new Int32Array(componentCount + 1);
    const eligibleById = new Array(componentCount + 1);
    let ignoredDustCount = 0;
    let ignoredDustInkPixels = 0;
    let lostCount = 0;
    let damagedCount = 0;
    let lostInkPixels = 0;
    let textInkPixels = 0;
    const xMap = makeScaleMap(source.width, alignment.scaleX ?? alignment.scale);
    const yMap = makeScaleMap(source.height, alignment.scaleY ?? alignment.scale);
    for (const component of sourceComponents) {
        const {
            area,
            height: componentHeight,
            id,
            width: componentWidth,
            x: minX,
            y: minY,
        } = component;
        if (
            area < minArea
            || componentHeight < 8
            || componentHeight > 220
        ) {
            continue;
        }
        const centerX = minX + (componentWidth - 1) / 2;
        const centerY = minY + (componentHeight - 1) / 2;
        if (plateRegions.some(region =>
            centerX >= region.x
            && centerX < region.x + region.width
            && centerY >= region.y
            && centerY < region.y + region.height,
        )) {
            continue;
        }
        eligibleById[id] = component;
        eligibleComponents.push(component);
        textInkPixels += area;
    }
    if (componentLabels) {
        for (let pixelIndex = 0; pixelIndex < source.pixels.length; pixelIndex += 1) {
            const componentId = componentLabels[pixelIndex];
            if (!componentId || !eligibleById[componentId]) {
                continue;
            }
            const sourceX = pixelIndex % sourceWidth;
            const sourceY = Math.floor(pixelIndex / sourceWidth);
            const cleanedX = xMap[sourceX] + alignment.dx;
            const cleanedY = yMap[sourceY] + alignment.dy;
            if (
                cleanedX >= 0
                && cleanedX < cleanedDilated.width
                && cleanedY >= 0
                && cleanedY < cleanedDilated.height
                && cleanedDilated.pixels[cleanedY * cleanedDilated.width + cleanedX]
            ) {
                coveredPixelsByComponent[componentId] += 1;
            }
        }
    }
    for (const component of eligibleComponents) {
        const {
            area,
            height: componentHeight,
            id,
            width: componentWidth,
            x: minX,
            y: minY,
        } = component;
        const coverage = area === 0 ? 0 : coveredPixelsByComponent[id] / area;
        const isDust = area < dustArea;
        const classification = isDust
            ? 'ignored-dust'
            : coverage < 0.25
                ? 'lost'
                : coverage < 0.6
                    ? 'damaged'
                    : 'preserved';
        if (isDust) {
            ignoredDustCount += 1;
            ignoredDustInkPixels += area;
        }
        if (classification === 'lost') {
            lostCount += 1;
            lostInkPixels += area;
        }
        if (classification === 'lost' || classification === 'damaged') {
            damagedCount += 1;
        }
        components.push({
            area,
            bbox: {
                height: componentHeight,
                width: componentWidth,
                x: minX,
                y: minY,
            },
            classification,
            coverage: roundNumber(coverage),
        });
    }
    return {
        components,
        damagedCount,
        ignoredDustCount,
        ignoredDustInkPixels,
        lostCount,
        lostInkFraction: textInkPixels === 0 ? 0 : lostInkPixels / textInkPixels,
        textInkPixels,
        totalTextComponents: components.length,
    };
}

function roundNumber(value, digits = 6) {
    return Number(value.toFixed(digits));
}

function pageError(pageNumber, error) {
    return {
        flagged: false,
        page: pageNumber,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
    };
}

async function analyzePage({
    cleanedRowsByPage,
    minArea,
    pageNumber,
    sourceRowsByPage,
    sourcePdf,
    cleanedPdf,
    workDirectory,
}) {
    const sourceRows = sourceRowsByPage.get(pageNumber) ?? [];
    const cleanedRows = cleanedRowsByPage.get(pageNumber) ?? [];
    const sourceRow = selectSourceMaskRow(sourceRows);
    if (!sourceRow) {
        return {
            flagged: false,
            page: pageNumber,
            reason: 'source has no 1-bit smask',
            status: 'skipped',
        };
    }
    const cleanedRow = selectCleanedInkRow(cleanedRows);
    if (!cleanedRow) {
        return {
            flagged: false,
            page: pageNumber,
            reason: 'cleaned page publishes no bilevel image or stencil',
            status: 'skipped',
        };
    }
    try {
        const source = await extractPngMask({
            pageNumber,
            pdfPath: sourcePdf,
            role: 'source',
            row: sourceRow,
            rows: sourceRows,
            workDirectory,
        });
        const cleaned = await extractPngMask({
            pageNumber,
            pdfPath: cleanedPdf,
            role: 'cleaned',
            row: cleanedRow,
            rows: cleanedRows,
            workDirectory,
        });
        const sourceAlignment = makeAlignmentBitmap(source, minArea, true);
        const cleanedAlignment = makeAlignmentBitmap(cleaned, minArea);
        const alignmentSource = sourceAlignment.bitmap;
        const alignmentCleaned = cleanedAlignment.bitmap;
        const alignmentSourceTop = alignmentSource;
        const alignmentCleanedTop = alignmentCleaned;
        const alignmentOne = alignAtScale(
            source,
            cleaned,
            1,
            alignmentSourceTop,
            alignmentCleanedTop,
        );
        const alignments = [alignmentOne];
        if (alignmentOne.overlapScore < 0.4) {
            alignments.push(alignAtScale(
                source,
                cleaned,
                CROP_SCALE,
                alignmentSourceTop,
                alignmentCleanedTop,
            ));
        }
        if (Math.max(...alignments.map(candidate => candidate.fullOverlapScore)) < 0.7) {
            const dimensionScaleValue = cleaned.width / source.width;
            const dimensionScale = {
                label: `dimension-fit(${dimensionScaleValue.toFixed(6)})`,
                x: dimensionScaleValue,
                y: dimensionScaleValue,
            };
            if (
                Math.abs(dimensionScale.x - 1) > 1e-6
                || Math.abs(dimensionScale.y - 1) > 1e-6
            ) {
                alignments.push(alignAtScale(
                    source,
                    cleaned,
                    dimensionScale,
                    alignmentSourceTop,
                    alignmentCleanedTop,
                ));
            }
        }
        const alignment = alignments.reduce((best, candidate) =>
            candidate.fullOverlapScore > best.fullOverlapScore ? candidate : best,
        );
        const cleanedDilated = dilateOnePixel(cleaned);
        const componentMetrics = analyzeComponents(
            source,
            cleanedDilated,
            alignment,
            minArea,
            sourceAlignment.plateRegions,
            sourceAlignment.components,
            sourceAlignment.componentLabels,
            sourceAlignment.componentCount,
        );
        const flagged =
            componentMetrics.lostCount >= 3
            || componentMetrics.lostInkFraction >= 0.01;
        const result = {
            alignment: {
                attemptedScales: alignments.map(candidate =>
                    scaleLabel(candidate.scale),
                ),
                dx: alignment.dx,
                dy: alignment.dy,
                fullOverlapScore: roundNumber(alignment.fullOverlapScore),
                overlapScore: roundNumber(alignment.overlapScore),
                reliable: alignment.overlapScore >= 0.4,
                scale: scaleLabel(alignment.scale),
                scaleX: roundNumber(alignment.scaleX),
                scaleY: roundNumber(alignment.scaleY),
                attempts: alignments.map(candidate => ({
                    broadDx: candidate.broadDx,
                    broadDy: candidate.broadDy,
                    dx: candidate.dx,
                    dy: candidate.dy,
                    fullOverlapScore: roundNumber(candidate.fullOverlapScore),
                    overlapScore: roundNumber(candidate.overlapScore),
                    quarterDx: candidate.quarterDx,
                    quarterDy: candidate.quarterDy,
                    scale: scaleLabel(candidate.scale),
                })),
            },
            cleanedInkPixels: cleaned.blackCount,
            alignmentSourceInkPixels: alignmentSource.blackCount,
            alignmentCleanedInkPixels: alignmentCleaned.blackCount,
            cleanedImage: {
                encoding: cleanedRow.encoding,
                height: cleaned.height,
                type: cleanedRow.type,
                width: cleaned.width,
            },
            damagedCount: componentMetrics.damagedCount,
            flagged,
            ignoredDustCount: componentMetrics.ignoredDustCount,
            ignoredDustInkPixels: componentMetrics.ignoredDustInkPixels,
            lostCount: componentMetrics.lostCount,
            lostInkFraction: roundNumber(componentMetrics.lostInkFraction),
            page: pageNumber,
            sourceImage: {
                encoding: sourceRow.encoding,
                height: source.height,
                type: sourceRow.type,
                width: source.width,
            },
            sourceInkPixels: source.blackCount,
            status: 'analyzed',
            totalTextComponents: componentMetrics.totalTextComponents,
            textInkPixels: componentMetrics.textInkPixels,
        };
        if (flagged) {
            result.components = componentMetrics.components;
        }
        return result;
    } catch (error) {
        return pageError(pageNumber, error);
    }
}

async function mapPages(pages, workers, task) {
    const results = new Array(pages.length);
    let cursor = 0;
    const workerCount = Math.min(workers, pages.length || 1);
    await Promise.all(Array.from({length: workerCount}, async (_, workerIndex) => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= pages.length) {
                return;
            }
            results[index] = await task(pages[index], workerIndex);
        }
    }));
    return results;
}

async function readPageCount(pdfPath, fallback) {
    const result = await run('pdfinfo', [pdfPath]);
    const match = /^Pages:\s+(\d+)$/mu.exec(result.stdout);
    return match ? Number(match[1]) : fallback;
}

function tableLine(page) {
    const offset = page.alignment
        ? `${String(page.alignment.dx)},${String(page.alignment.dy)}`
        : '-';
    const overlap = page.alignment ? page.alignment.overlapScore.toFixed(3) : '-';
    const scale = page.alignment?.scale ?? '-';
    return [
        String(page.page).padStart(4),
        String(page.totalTextComponents).padStart(10),
        String(page.lostCount).padStart(4),
        String(page.damagedCount).padStart(8),
        page.lostInkFraction.toFixed(4).padStart(9),
        offset.padStart(9),
        overlap.padStart(7),
        scale.padStart(10),
    ].join(' ');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        return;
    }
    await mkdir(artifactDirectory, {recursive: true});
    await mkdir(dirname(options.out), {recursive: true});
    const [
        sourceListingResult,
        cleanedListingResult,
    ] = await Promise.all([
        run('pdfimages', [
            '-list',
            options.source,
        ]),
        run('pdfimages', [
            '-list',
            options.cleaned,
        ]),
    ]);
    const sourceRows = parsePdfImagesListing(sourceListingResult.stdout);
    const cleanedRows = parsePdfImagesListing(cleanedListingResult.stdout);
    const sourceRowsByPage = groupRowsByPage(sourceRows);
    const cleanedRowsByPage = groupRowsByPage(cleanedRows);
    const [
        sourcePageCount,
        cleanedPageCount,
    ] = await Promise.all([
        readPageCount(options.source, Math.max(...sourceRows.map(row => row.page), 0)),
        readPageCount(options.cleaned, Math.max(...cleanedRows.map(row => row.page), 0)),
    ]);
    const from = options.from ?? 1;
    const to = options.to ?? sourcePageCount;
    if (from > to) {
        throw new Error('--from must not be greater than --to');
    }
    if (to > sourcePageCount) {
        throw new Error(`--to ${String(to)} exceeds source page count ${String(sourcePageCount)}`);
    }
    if (to > cleanedPageCount) {
        throw new Error(`--to ${String(to)} exceeds cleaned page count ${String(cleanedPageCount)}`);
    }
    const pages = Array.from({length: to - from + 1}, (_, index) => from + index);
    const temporaryRoot = await mkdtemp(join(artifactDirectory, '.word-loss-audit-'));
    try {
        await Promise.all(Array.from({length: Math.min(options.workers, pages.length || 1)}, (_, index) =>
            mkdir(join(temporaryRoot, `worker-${String(index)}`), {recursive: true}),
        ));
        const startedAt = Date.now();
        const pageResults = await mapPages(pages, options.workers, (pageNumber, workerIndex) =>
            analyzePage({
                cleanedPdf: options.cleaned,
                cleanedRowsByPage,
                minArea: options.minArea,
                pageNumber,
                sourcePdf: options.source,
                sourceRowsByPage,
                workDirectory: join(temporaryRoot, `worker-${String(workerIndex)}`),
            }),
        );
        const elapsedMs = Date.now() - startedAt;
        const flaggedPages = pageResults
            .filter(page => page.status === 'analyzed' && page.flagged)
            .map(page => page.page);
        const report = {
            generatedAt: new Date().toISOString(),
            inputs: {
                cleaned: options.cleaned,
                from,
                minArea: options.minArea,
                source: options.source,
                to,
                workers: options.workers,
            },
            pages: pageResults,
            summary: {
                analyzedPages: pageResults.filter(page => page.status === 'analyzed').length,
                elapsedMs,
                errorPages: pageResults.filter(page => page.status === 'error').map(page => page.page),
                flaggedCount: flaggedPages.length,
                flaggedPages,
                pageCount: pageResults.length,
                skippedPages: pageResults.filter(page => page.status === 'skipped').map(page => page.page),
            },
            tool: {
                alignment: {
                    broadDownsample: '16x',
                    quarterDownsample: '4x',
                    refinementRadiusFullPixels: 4,
                    searchRadiusFullPixels: ALIGNMENT_RADIUS_FULL_PX,
                    scaleFallback: '2197/2261',
                },
                name: 'scan-cleanup-word-loss-audit',
                version: 1,
            },
        };
        await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`Wrote JSON report: ${options.out}`);
        console.log(`Pages: ${String(from)}-${String(to)}; flagged: ${String(flaggedPages.length)}; elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
        console.log('');
        console.log('page components lost damaged lost-ink offset overlap scale');
        console.log('---- ---------- ---- ------- -------- -------- ------- ----------');
        if (flaggedPages.length === 0) {
            console.log('(none)');
        } else {
            for (const pageNumber of flaggedPages) {
                console.log(tableLine(pageResults[pageNumber - from]));
            }
        }
    } finally {
        await rm(temporaryRoot, {
            force: true,
            recursive: true,
        });
    }
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
} finally {
    process.exitCode = 0;
}
