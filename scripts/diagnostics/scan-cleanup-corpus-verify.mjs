#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {
    access,
    mkdir,
    open,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {
    dirname,
    isAbsolute,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    assertStagedCargoArtifactFresh,
    collectCargoSourceInputs,
} from '../cargo-artifacts.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultConfigPath = join(projectRoot, '.devkit/scan-cleanup-corpus.json');
const defaultExpectedPath = join(projectRoot, 'scripts/diagnostics/scan-cleanup-corpus-expected-results.json');
const platformArch = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const binaryExtension = process.platform === 'win32' ? '.exe' : '';
const defaultScanCleanupBinary = join(
    projectRoot,
    '.tmp/scan-cleanup',
    platformArch,
    'bin',
    `evb-scan-cleanup${binaryExtension}`,
);
const defaultCombineBinary = join(
    projectRoot,
    '.tmp/pdf-image-combine',
    platformArch,
    'bin',
    `evb-pdf-image-combine${binaryExtension}`,
);
const nativeTools = [
    {
        binaryPath: defaultScanCleanupBinary,
        buildCommand: 'pnpm run build:scan-cleanup',
        manifestPath: join(projectRoot, 'native/scan-cleanup/Cargo.toml'),
    },
    {
        binaryPath: defaultCombineBinary,
        buildCommand: 'pnpm run build:pdf-image-combine',
        manifestPath: join(projectRoot, 'native/pdf-image-combine/Cargo.toml'),
    },
];
const MAX_DIMENSION_PX = 40_000;
const MAX_BILEVEL_PIXELS = 160_000_000;
const MAX_CONTINUOUS_TONE_PIXELS = 80_000_000;

function parseArgs(argv) {
    const parsed = {
        config: defaultConfigPath,
        expected: defaultExpectedPath,
        keepArtifacts: false,
        workDir: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') {
            continue;
        }
        if (argument === '--keep-artifacts') {
            parsed.keepArtifacts = true;
        } else if (argument === '--config' || argument === '--expected' || argument === '--work-dir') {
            const value = argv[index + 1];
            if (!value) throw new Error(`Missing value for ${argument}`);
            parsed[argument === '--work-dir' ? 'workDir' : argument.slice(2)] = resolve(value);
            index += 1;
        } else if (argument === '--help' || argument === '-h') {
            console.log(`Usage: node scripts/diagnostics/scan-cleanup-corpus-verify.mjs [options]

Options:
  --config <path>       Machine-local fixture config (default: .devkit/scan-cleanup-corpus.json)
  --expected <path>     Checked-in expected results JSON
  --work-dir <path>     Write artifacts to an explicit directory
  --keep-artifacts      Retain an automatically created work directory after a passing run`);
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    return parsed;
}

async function run(command, args, options = {}) {
    return new Promise((resolveRun, reject) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            env: {
                ...process.env,
                ...options.env,
            },
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
        child.once('error', reject);
        child.once('exit', code => {
            if (code !== 0 && !options.allowFailure) {
                reject(new Error([
                    `${command} ${args.join(' ')} exited with ${String(code)}`,
                    stderr.trim(),
                    stdout.trim(),
                ].filter(Boolean).join('\n')));
                return;
            }
            resolveRun({
                code,
                stderr,
                stdout,
            });
        });
    });
}

async function assertCorpusNativeBinariesFresh() {
    for (const tool of nativeTools) {
        if (!await readableFile(tool.binaryPath)) {
            throw new Error(`Missing staged release binary: ${tool.binaryPath}\nRun ${tool.buildCommand} first.`);
        }
        const cargoMetadata = await run('cargo', [
            'metadata',
            '--manifest-path',
            tool.manifestPath,
            '--format-version',
            '1',
            '--locked',
            '--no-deps',
        ]);
        let parsedMetadata;
        try {
            parsedMetadata = JSON.parse(cargoMetadata.stdout);
        } catch (error) {
            throw new Error(`Cargo metadata returned invalid JSON for ${tool.manifestPath}`, {cause: error});
        }
        await assertStagedCargoArtifactFresh({
            ...tool,
            sourcePaths: collectCargoSourceInputs(parsedMetadata, tool.manifestPath),
        });
    }
}

function assertionReporter(fixtureId) {
    const assertions = [];
    return {
        add(label, passed, detail) {
            assertions.push({
                detail,
                label,
                passed,
            });
            console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}: ${detail}`);
        },
        assertions,
        fixtureId,
    };
}

function parseDominantSourceDpi(output, pageNumber) {
    const candidates = output.split(/\r?\n/u)
        .map(line => line.trim().split(/\s+/u))
        .filter(parts => Number(parts[0]) === pageNumber && parts[2] === 'image')
        .map(parts => ({
            area: Number(parts[3]) * Number(parts[4]),
            xPpi: Number(parts[12]),
            yPpi: Number(parts[13]),
        }))
        .filter(candidate => Number.isFinite(candidate.area)
            && Number.isFinite(candidate.xPpi)
            && candidate.xPpi > 0
            && Number.isFinite(candidate.yPpi)
            && candidate.yPpi > 0);
    candidates.sort((left, right) => right.area - left.area);
    const dominant = candidates[0];
    return dominant ? Math.max(1, Math.round(Math.max(dominant.xPpi, dominant.yPpi))) : 300;
}

function nativeOptions(dpi, sourceDpi, requestedRenderDpi, outputMode = 'auto') {
    return {
        dpi,
        sourceDpi,
        requestedRenderDpi,
        binarization: 'auto',
        thickness: 0,
        normalizeIllumination: true,
        despeckle: true,
        outputMode,
        ocrMode: false,
        layout: 'auto',
        manualSplit: null,
        manualContentBoxes: {},
        cropContent: true,
        matchPageSize: true,
        pageAlignment: 'top-center',
        placementOverrides: {},
        margins: {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        },
        experimental: {autoDewarp: false},
        rotationDegrees: 0,
        excluded: false,
        skipBlankPages: false,
        maxPixels: outputMode === 'bw' || outputMode === 'auto'
            ? MAX_BILEVEL_PIXELS
            : MAX_CONTINUOUS_TONE_PIXELS,
        maxDimensionPx: MAX_DIMENSION_PX,
    };
}

function tonalJpegQuality(mode) {
    if (mode === 'color') {
        return 87;
    }
    if (mode === 'grayscale' || mode === 'mixed') {
        return 85;
    }
    return null;
}

async function rasterize(pdfPath, pageNumber, dpi, outputPrefix) {
    await run('pdftoppm', [
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-r',
        String(dpi),
        '-png',
        '-singlefile',
        pdfPath,
        outputPrefix,
    ]);
    return `${outputPrefix}.png`;
}

async function readPngHeader(path) {
    const handle = await open(path, 'r');
    try {
        const header = Buffer.alloc(26);
        const {bytesRead} = await handle.read(header, 0, header.byteLength, 0);
        if (
            bytesRead !== header.byteLength
            || header.subarray(0, 8).compare(Buffer.from([
                0x89,
                0x50,
                0x4e,
                0x47,
                0x0d,
                0x0a,
                0x1a,
                0x0a,
            ])) !== 0
        ) {
            throw new Error(`Invalid PNG header: ${path}`);
        }
        const colorType = header[25];
        return {
            height: header.readUInt32BE(20),
            isColor: colorType === 2 || colorType === 3 || colorType === 6,
            width: header.readUInt32BE(16),
        };
    } finally {
        await handle.close();
    }
}

function resolveSafeRenderDpi(requestedRenderDpi, maxPixels, sourceDpi, dimensions) {
    const maxDimensionDpi = sourceDpi * Math.min(
        MAX_DIMENSION_PX / dimensions.width,
        MAX_DIMENSION_PX / dimensions.height,
    );
    const maxPixelDpi = sourceDpi * Math.sqrt(
        maxPixels / (dimensions.width * dimensions.height),
    );
    return Math.max(1, Math.floor(Math.min(
        requestedRenderDpi,
        maxDimensionDpi,
        maxPixelDpi,
    )));
}

async function runSidecar(manifestPath) {
    const result = await run(defaultScanCleanupBinary, [
        '--manifest',
        manifestPath,
    ]);
    const envelopes = result.stdout.split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line));
    const terminal = envelopes.findLast(envelope => envelope.type === 'result');
    if (terminal?.result?.status !== 'success') {
        throw new Error(`Scan-cleanup sidecar did not report success: ${result.stdout}`);
    }
}

async function readableFile(path) {
    try {
        await access(path, fsConstants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function parsePdfImages(output) {
    return output.split(/\r?\n/u)
        .map(line => line.trim().split(/\s+/u))
        .filter(parts => Number.isSafeInteger(Number(parts[0])) && parts.length >= 14)
        .map(parts => ({
            bitsPerComponent: Number(parts[7]),
            encoding: parts[8],
            page: Number(parts[0]),
            type: parts[2],
        }));
}

function parseMediaBoxes(output) {
    return output.split(/\r?\n/u).flatMap(line => {
        const match = /^Page\s+\d+\s+MediaBox:\s+[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)/u.exec(line);
        return match ? [[
            Number(match[1]),
            Number(match[2]),
        ]] : [];
    });
}

function timingStats(records) {
    const values = records.map(record => record.elapsedMs);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
        count: values.length,
        maxMs: values.length === 0 ? 0 : Math.max(...values),
        meanMs: values.length === 0 ? 0 : total / values.length,
        totalMs: total,
    };
}

async function verifyFixture(fixture, expectedFixture, workRoot) {
    const report = assertionReporter(fixture.id);
    const fixtureDir = join(workRoot, fixture.id);
    await mkdir(fixtureDir, {recursive: true});
    console.log(`\n${fixture.id}`);

    const pageRuns = [];
    for (const pageNumber of fixture.pages) {
        const dpiListing = await run('pdfimages', [
            '-f',
            String(pageNumber),
            '-l',
            String(pageNumber),
            '-list',
            fixture.pdfPath,
        ]);
        const sourceDpi = parseDominantSourceDpi(dpiListing.stdout, pageNumber);
        const sourceRaster = await rasterize(
            fixture.pdfPath,
            pageNumber,
            sourceDpi,
            join(fixtureDir, `source-${pageNumber}-${sourceDpi}dpi`),
        );
        const analysisMetadataPath = join(fixtureDir, `analysis-${pageNumber}.json`);
        const analysisManifestPath = join(fixtureDir, `analysis-${pageNumber}-manifest.json`);
        await writeFile(analysisManifestPath, JSON.stringify({
            version: 3,
            operation: 'analyze',
            renderMode: 'final',
            canvasScope: 'page',
            pages: [{
                inputPath: sourceRaster,
                sourcePageIndex: pageNumber - 1,
                pageMetadataPath: analysisMetadataPath,
                options: nativeOptions(sourceDpi, sourceDpi, sourceDpi),
                outputs: [],
            }],
        }, null, 2));
        await runSidecar(analysisManifestPath);
        const analysis = JSON.parse(await readFile(analysisMetadataPath, 'utf8'));
        const supersampled = analysis.recommendedOutputMode === 'bw'
            || analysis.recommendedOutputMode === 'mixed';
        const requestedRenderDpi = supersampled
            ? Math.max(sourceDpi * 2, 600)
            : sourceDpi;
        const renderDpi = supersampled
            ? resolveSafeRenderDpi(
                requestedRenderDpi,
                analysis.recommendedOutputMode === 'bw'
                    ? MAX_BILEVEL_PIXELS
                    : MAX_CONTINUOUS_TONE_PIXELS,
                sourceDpi,
                await readPngHeader(sourceRaster),
            )
            : sourceDpi;
        const renderRaster = renderDpi === sourceDpi
            ? sourceRaster
            : await rasterize(
                fixture.pdfPath,
                pageNumber,
                renderDpi,
                join(fixtureDir, `render-${pageNumber}-${renderDpi}dpi`),
            );
        pageRuns.push({
            analysis,
            pageNumber,
            renderDpi,
            renderRaster,
            requestedRenderDpi,
            sourceDpi,
        });
    }

    const renderPages = pageRuns.map(page => ({
        inputPath: page.renderRaster,
        sourcePageIndex: page.pageNumber - 1,
        pageMetadataPath: join(fixtureDir, `clean-${page.pageNumber}-page.json`),
        options: nativeOptions(
            page.renderDpi,
            page.sourceDpi,
            page.requestedRenderDpi,
            page.analysis.recommendedOutputMode,
        ),
        outputs: [
            0,
            1,
        ].map(index => ({
            outputPath: join(fixtureDir, `clean-${page.pageNumber}-${index}.png`),
            metadataPath: join(fixtureDir, `clean-${page.pageNumber}-${index}.json`),
            bilevelOutputPath: join(fixtureDir, `clean-${page.pageNumber}-${index}.pbm`),
            backgroundOutputPath: join(fixtureDir, `clean-${page.pageNumber}-${index}-background.png`),
            foregroundMaskOutputPath: join(fixtureDir, `clean-${page.pageNumber}-${index}-mask.pbm`),
        })),
    }));
    const renderManifestPath = join(fixtureDir, 'render-manifest.json');
    await writeFile(renderManifestPath, JSON.stringify({
        version: 3,
        operation: 'render',
        renderMode: 'final',
        canvasScope: 'document',
        pages: renderPages,
    }, null, 2));
    await runSidecar(renderManifestPath);

    const combinedPages = [];
    for (const [
        pageIndex,
        page,
    ] of pageRuns.entries()) {
        const renderPage = renderPages[pageIndex];
        const expectedPage = expectedFixture?.pages?.[String(page.pageNumber)];
        const outputFiles = [];
        for (const output of renderPage.outputs) {
            if (!await readableFile(output.outputPath)) continue;
            const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8'));
            const bilevelPath = metadata.bilevelWritten && await readableFile(output.bilevelOutputPath)
                ? output.bilevelOutputPath
                : null;
            const layered = metadata.layeredWritten
                && await readableFile(output.backgroundOutputPath)
                && await readableFile(output.foregroundMaskOutputPath);
            const backgroundPath = layered ? output.backgroundOutputPath : null;
            const foregroundMaskPath = layered ? output.foregroundMaskOutputPath : null;
            const backgroundIsColor = backgroundPath
                ? (await readPngHeader(backgroundPath)).isColor
                : false;
            outputFiles.push({
                backgroundIsColor,
                backgroundPath,
                bilevelPath,
                foregroundMaskPath,
                metadata,
                outputPath: output.outputPath,
            });
            combinedPages.push({
                backgroundIsColor,
                backgroundPath,
                bilevelPath,
                foregroundMaskPath,
                metadata,
                mode: page.analysis.recommendedOutputMode,
                outputPath: output.outputPath,
                renderDpi: metadata.renderDpi ?? page.renderDpi,
            });
        }
        if (expectedPage) {
            report.add(
                `page ${page.pageNumber} resolved mode`,
                page.analysis.recommendedOutputMode === expectedPage.mode,
                `${String(page.analysis.recommendedOutputMode)} (expected ${expectedPage.mode})`,
            );
            report.add(
                `page ${page.pageNumber} recommendation reason`,
                page.analysis.recommendedOutputModeReason === expectedPage.reason,
                `${String(page.analysis.recommendedOutputModeReason)} (expected ${expectedPage.reason})`,
            );
            const confidence = Number(page.analysis.recommendedOutputModeConfidence);
            report.add(
                `page ${page.pageNumber} confidence`,
                confidence >= expectedPage.minConfidence,
                `${confidence.toFixed(4)} (minimum ${expectedPage.minConfidence.toFixed(2)})`,
            );
            report.add(
                `page ${page.pageNumber} output count`,
                outputFiles.length === expectedPage.outputCount,
                `${outputFiles.length} (expected ${expectedPage.outputCount})`,
            );
        }
    }

    const compactManifestPath = join(fixtureDir, 'combine-manifest.tsv');
    await writeFile(compactManifestPath, combinedPages.map(page => {
        const pageSize = [
            (page.metadata.matchedCanvasTargetWidthPoints
            ?? page.metadata.canvasWidthPx / page.renderDpi * 72).toFixed(6),
            (page.metadata.matchedCanvasTargetHeightPoints
            ?? page.metadata.canvasHeightPx / page.renderDpi * 72).toFixed(6),
        ];
        if (page.bilevelPath) {
            return [
                'image-bilevel',
                ...pageSize,
                page.bilevelPath,
            ].join('\t');
        }
        if (page.backgroundPath && page.foregroundMaskPath) {
            return [
                'layered-jpeg',
                ...pageSize,
                page.backgroundIsColor ? 87 : 85,
                page.backgroundPath,
                page.foregroundMaskPath,
            ].join('\t');
        }
        const jpegQuality = page.metadata.bilevelWritten ? null : tonalJpegQuality(page.mode);
        return jpegQuality === null
            ? [
                'image',
                ...pageSize,
                page.outputPath,
            ].join('\t')
            : [
                'image-jpeg',
                ...pageSize,
                jpegQuality,
                page.outputPath,
            ].join('\t');
    }).join('\n') + '\n');
    const outputPdfPath = join(fixtureDir, `${fixture.id}.pdf`);
    const combine = await run(defaultCombineBinary, [
        '--output',
        outputPdfPath,
        '--compact-manifest',
        compactManifestPath,
        '--json-progress',
    ], {env: {EVB_PDF_COMBINE_TIMING: '1'}});
    const timings = combine.stderr.split(/\r?\n/u).flatMap(line => {
        try {
            const value = JSON.parse(line);
            return value.type === 'jbig2-encode-timing' ? [value] : [];
        } catch {
            return [];
        }
    });
    const bilevelPages = combinedPages
        .map((page, index) => ({
            ...page,
            pdfPage: index + 1,
        }))
        .filter(page => page.bilevelPath);
    const layeredPages = combinedPages
        .map((page, index) => ({
            ...page,
            pdfPage: index + 1,
        }))
        .filter(page => page.foregroundMaskPath);
    const maskPages = [
        ...bilevelPages,
        ...layeredPages,
    ];
    const imageListing = parsePdfImages((await run('pdfimages', [
        '-list',
        outputPdfPath,
    ])).stdout);
    for (const page of bilevelPages) {
        const image = imageListing.find(candidate => candidate.page === page.pdfPage && candidate.type === 'image');
        report.add(
            `output page ${page.pdfPage} is 1-bit JBIG2`,
            image?.bitsPerComponent === 1 && image.encoding === 'jbig2',
            image ? `${image.bitsPerComponent}-bit ${image.encoding}` : 'no image found',
        );
    }
    for (const page of layeredPages) {
        const mask = imageListing.find(candidate =>
            candidate.page === page.pdfPage
            && candidate.type === 'stencil',
        );
        report.add(
            `output page ${page.pdfPage} foreground mask is 1-bit JBIG2`,
            mask?.bitsPerComponent === 1 && mask.encoding === 'jbig2',
            mask ? `${mask.bitsPerComponent}-bit ${mask.encoding}` : 'no mask found',
        );
    }

    const extractedPrefix = join(fixtureDir, 'extracted');
    await run('pdfimages', [
        '-png',
        outputPdfPath,
        extractedPrefix,
    ]);
    for (const page of bilevelPages) {
        const extractedPath = `${extractedPrefix}-${String(page.pdfPage - 1).padStart(3, '0')}.png`;
        const comparison = await run('compare', [
            '-metric',
            'AE',
            page.bilevelPath,
            extractedPath,
            'null:',
        ], {allowFailure: true});
        const metricMatch = /^\s*([0-9.e+-]+)/iu.exec(comparison.stderr);
        const absoluteError = metricMatch ? Number(metricMatch[1]) : Number.NaN;
        report.add(
            `output page ${page.pdfPage} PBM roundtrip`,
            absoluteError === 0,
            `absolute error ${Number.isFinite(absoluteError) ? absoluteError : comparison.stderr.trim()} (exit ${String(comparison.code)})`,
        );
    }

    const boxes = parseMediaBoxes((await run('pdfinfo', [
        '-f',
        '1',
        '-l',
        String(combinedPages.length),
        '-box',
        outputPdfPath,
    ])).stdout);
    const boxKeys = new Set(boxes.map(box => box.map(value => value.toFixed(2)).join('x')));
    report.add(
        'uniform MediaBoxes',
        boxes.length === combinedPages.length && boxKeys.size === 1,
        boxes.length === 0 ? 'no MediaBoxes found' : [...boxKeys].join(', '),
    );

    const outputBytes = (await stat(outputPdfPath)).size;
    if (expectedFixture?.expectedOutputBytes) {
        const lower = expectedFixture.expectedOutputBytes * 0.7;
        const upper = expectedFixture.expectedOutputBytes * 1.3;
        report.add(
            'output size envelope',
            outputBytes >= lower && outputBytes <= upper,
            `${outputBytes.toLocaleString('en-US')} B (expected ${expectedFixture.expectedOutputBytes.toLocaleString('en-US')} B ±30%)`,
        );
    }
    const stats = timingStats(timings);
    report.add(
        'JBIG2 encode timing coverage',
        timings.length === maskPages.length
            && timings.every(record => Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0),
        `${stats.count} records; total=${stats.totalMs.toFixed(1)}ms mean=${stats.meanMs.toFixed(1)}ms max=${stats.maxMs.toFixed(1)}ms`,
    );
    return {
        ...report,
        outputBytes,
        outputPdfPath,
        timing: stats,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = JSON.parse(await readFile(args.config, 'utf8'));
    const expected = JSON.parse(await readFile(args.expected, 'utf8'));
    if (!Array.isArray(config.fixtures) || config.fixtures.length === 0) {
        throw new Error('Corpus config must contain a non-empty fixtures array');
    }
    await assertCorpusNativeBinariesFresh();
    const workRoot = args.workDir ?? join(
        projectRoot,
        '.devkit',
        `scan-cleanup-corpus-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`,
    );
    await mkdir(workRoot, {recursive: true});
    const reports = [];
    for (const fixture of config.fixtures) {
        if (
            typeof fixture.id !== 'string'
            || typeof fixture.pdfPath !== 'string'
            || !isAbsolute(fixture.pdfPath)
            || !Array.isArray(fixture.pages)
            || fixture.pages.some(page => !Number.isSafeInteger(page) || page < 1)
        ) throw new Error(`Invalid corpus fixture config: ${JSON.stringify(fixture)}`);
        if (!await readableFile(fixture.pdfPath)) {
            if (fixture.optional) {
                console.log(`\n[SKIP] ${fixture.id}: optional fixture is absent (${fixture.pdfPath})`);
                continue;
            }
            throw new Error(`Required corpus fixture is absent: ${fixture.pdfPath}`);
        }
        reports.push(await verifyFixture(fixture, expected.fixtures?.[fixture.id], workRoot));
    }
    const assertionCount = reports.flatMap(report => report.assertions).length;
    const failed = reports.flatMap(report => report.assertions).filter(assertion => !assertion.passed);
    console.log(`\nCorpus summary: ${reports.length} fixture(s), ${assertionCount} assertions, ${failed.length} failure(s)`);
    console.log(`Artifacts: ${workRoot}`);
    if (failed.length > 0) process.exitCode = 1;
    if (!args.keepArtifacts && !args.workDir && failed.length === 0) {
        await rm(workRoot, {
            force: true,
            recursive: true,
        });
        console.log('Artifacts removed after passing run (use --keep-artifacts to retain them).');
    }
}

await main().catch(error => {
    console.error(`\n[FATAL] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
