import { performance } from 'node:perf_hooks';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {
    execFile,
    spawn,
} from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import {
    getCargoArtifactPath,
    resolveCargoTargetDirectory,
} from './cargo-artifacts.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const cargoTargetDirectory = resolveCargoTargetDirectory({
    manifestPath: 'native/Cargo.toml',
    projectRoot: root,
});
const searchBinary = getCargoArtifactPath({
    fileName: `evb-pdf-search${executableSuffix}`,
    targetDirectory: cargoTargetDirectory,
});
const imageBinary = getCargoArtifactPath({
    fileName: `evb-pdf-image-combine${executableSuffix}`,
    targetDirectory: cargoTargetDirectory,
});
const labelIndex = process.argv.indexOf('--label');
const outputIndex = process.argv.indexOf('--output');
const label = labelIndex >= 0 ? process.argv[labelIndex + 1] : null;
const outputPath = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : null;
if (!label || !outputPath) {
    throw new Error('Usage: node scripts/benchmark-native-release-profiles.mjs --label <name> --output <path>');
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function serializeIndex(pageCount, revision) {
    const revisionBytes = Buffer.from(revision);
    const texts = Array.from({length: pageCount}, (_value, index) => `page ${index + 1} alpha beta gamma alpha`);
    const pageTableOffset = 64 + revisionBytes.length;
    const textDataOffset = pageTableOffset + pageCount * 24;
    const records = [];
    const textBytes = [];
    let offset = textDataOffset;
    for (let index = 0; index < texts.length; index += 1) {
        const bytes = Buffer.from(texts[index]);
        const record = Buffer.alloc(24);
        record.writeUInt32LE(index + 1, 0);
        record.writeBigUInt64LE(BigInt(offset), 8);
        record.writeBigUInt64LE(BigInt(bytes.length), 16);
        records.push(record);
        textBytes.push(bytes);
        offset += bytes.length;
    }
    const header = Buffer.alloc(64);
    header.write('EVBSIDX2', 0, 'ascii');
    header.writeUInt32LE(2, 8);
    header.writeUInt32LE(64, 12);
    header.writeUInt32LE(pageCount, 16);
    header.writeUInt32LE(pageCount, 20);
    header.writeUInt32LE(revisionBytes.length, 28);
    header.writeBigUInt64LE(64n, 32);
    header.writeBigUInt64LE(BigInt(pageTableOffset), 40);
    header.writeBigUInt64LE(BigInt(textDataOffset), 48);
    return Buffer.concat([
        header,
        revisionBytes,
        ...records,
        ...textBytes,
    ]);
}

async function timeOneShotSearch(indexPath, revision, iterations) {
    const timings = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const startedAt = performance.now();
        await execFileAsync(searchBinary, [
            'search',
            '--index',
            indexPath,
            '--query',
            'alpha',
            '--document-revision',
            revision,
            '--limit',
            '500',
            '--context',
            '24',
        ]);
        timings.push(performance.now() - startedAt);
    }
    return timings;
}

async function timePersistentSearch(indexPath, revision, iterations) {
    const child = spawn(searchBinary, ['serve'], {stdio: [
        'pipe',
        'pipe',
        'inherit',
    ]});
    const lines = createInterface({input: child.stdout});
    const queuedLines = [];
    const waiters = [];
    lines.on('line', (line) => {
        const waiter = waiters.shift();
        if (waiter) {
            waiter(line);
        } else {
            queuedLines.push(line);
        }
    });
    const nextLine = () => new Promise((resolveLine) => {
        const line = queuedLines.shift();
        if (line !== undefined) {
            resolveLine(line);
        } else {
            waiters.push(resolveLine);
        }
    });
    await nextLine();
    const timings = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const requestId = `benchmark-${iteration}`;
        const startedAt = performance.now();
        child.stdin.write(`${JSON.stringify({
            type: 'search',
            requestId,
            indexPath,
            query: 'alpha',
            documentRevision: revision,
            limit: 500,
            contextChars: 24,
            matchCase: false,
        })}\n`);
        const result = JSON.parse(await nextLine());
        if (result.type !== 'result' || result.requestId !== requestId) {
            throw new Error('Persistent search benchmark received an invalid frame');
        }
        timings.push(performance.now() - startedAt);
    }
    child.kill();
    return timings;
}

async function timeNetpbmProbe(path, iterations) {
    const timings = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const startedAt = performance.now();
        await execFileAsync(imageBinary, [
            '--probe-netpbm',
            path,
        ]);
        timings.push(performance.now() - startedAt);
    }
    return timings;
}

const directory = await mkdtemp(join(tmpdir(), 'evb-native-profile-benchmark-'));
try {
    const revision = 'native-release-profile-benchmark';
    const indexPath = join(directory, 'benchmark.search-index.bin');
    const ppmPath = join(directory, 'benchmark.ppm');
    await writeFile(indexPath, serializeIndex(100, revision));
    await writeFile(ppmPath, Buffer.concat([
        Buffer.from('P6\n512 512\n255\n'),
        Buffer.alloc(512 * 512 * 3, 170),
    ]));
    const iterations = 15;
    const oneShot = await timeOneShotSearch(indexPath, revision, iterations);
    const persistent = await timePersistentSearch(indexPath, revision, iterations);
    const probe = await timeNetpbmProbe(ppmPath, iterations);
    const measurement = {
        binaryBytes: {
            imageCombine: (await stat(imageBinary)).size,
            search: (await stat(searchBinary)).size,
        },
        iterations,
        medianMs: {
            netpbmProbeSpawn: median(probe),
            searchOneShot: median(oneShot),
            searchPersistentWarm: median(persistent.slice(1)),
        },
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
    };
    let evidence = {
        schemaVersion: 1,
        measurements: {},
    };
    try {
        evidence = JSON.parse(await readFile(outputPath, 'utf8'));
    } catch {
        // The first benchmark run creates the evidence file.
    }
    evidence.measurements[label] = measurement;
    await mkdir(dirname(outputPath), {recursive: true});
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
} finally {
    await rm(directory, {
        force: true,
        recursive: true,
    });
}
