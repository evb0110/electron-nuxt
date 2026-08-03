/* eslint-disable custom/file-naming -- The task contract fixes this CLI filename. */
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    join,
    resolve,
} from 'node:path';
import {
    availableParallelism,
    tmpdir,
    totalmem,
} from 'node:os';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupOptions,
    TScanCleanupOutputModeSetting,
    TScanCleanupProgress,
} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {extractPdfMrcLayers} from '@scan-cleanup-adapters/extractPdfMrcLayers';
import {readPdfPageSizes} from '@scan-cleanup-core/pdfPageSizes';
import {readAvailableScratchBytes} from '@scan-cleanup-core/resolveRasterHandoff';
import {detectSourceDpiDetails} from '@scan-cleanup-core/sourceDpiDetection';
import {
    runScanCleanupDetection,
    type IScanCleanupDetectionDependencies,
    type IScanCleanupDetectionRetention,
    type IScanCleanupDocumentRasterPages,
    type IScanCleanupRetainedRaster,
} from '@scan-cleanup-core/detection';
import {
    runScanCleanupConversion,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
} from '@scan-cleanup-core/runScanCleanupConversion';
import type {
    IScanCleanupProcessResult,
    IRunScanCleanupPipelineDependencies,
    IReadPdfPageSizesOptions,
    TScanCleanupGetPageCount,
    TScanCleanupGetPageSizes,
    TScanCleanupRunCommand,
    IScanCleanupRunCommandOptions,
    TScanCleanupLog,
} from '@scan-cleanup-core/types';
import {
    createCliRenderers,
    requireCliPublishedRaster,
    resolveCliNativeToolPath,
    runCliNativeToolCommand,
    runCliScanCleanupSidecar,
    writeCliWasmPdfPage,
    type ICliPdfCombineWasmPage,
} from '@scripts/scanCleanupCliAdapters';

const PAGE_OPS_FALLBACK = '__scan_cleanup_cli_page_ops_fallback__';
const IMAGE_COMBINE_FALLBACK = '__scan_cleanup_cli_image_combine_fallback__';

interface IScanCleanupCliArguments {
    sourcePdfPath: string;
    outputPdfPath: string;
    pages?: number[];
    options: IScanCleanupOptions;
}

interface IScanCleanupCliDocument {
    directory: string;
    sourcePdfPath: string;
}

interface IScanCleanupRepresentationReport {
    outputBytes: number;
    outputToSourceByteRatio: number;
    pages: Array<{
        outputPageNumber: number;
        sourcePageNumber: number;
        representation: string;
        streamBytes?: {
            composite?: number;
            bilevel?: number;
            background?: number;
            foregroundMask?: number;
            foregroundAlpha?: number;
        };
    }>;
    sourceBytes: number;
}

function buildSourcePageToOutputPages(
    pages: IScanCleanupRepresentationReport['pages'],
) {
    const outputPagesBySource = new Map<number, number[]>();
    for (const page of pages) {
        const outputPages = outputPagesBySource.get(page.sourcePageNumber) ?? [];
        outputPages.push(page.outputPageNumber);
        outputPagesBySource.set(page.sourcePageNumber, outputPages);
    }
    return [...outputPagesBySource]
        .sort(([left], [right]) => left - right)
        .map(([
            sourcePage,
            outputPages,
        ]) => ({
            outputPages,
            sourcePage,
        }));
}

function printUsage() {
    process.stderr.write([
        'Usage: pnpm tsx scripts/scan-cleanup-convert.ts --source <pdf> --out <pdf> [flags]',
        '',
        'Flags:',
        '  --no-crop-content',
        '  --no-match-page-size',
        '  --output-mode auto|bw|gray|color|mixed',
        '  --pages <list-or-ranges>',
        '  --preserve-original-quality',
        '  --layout-mode auto|force-single|force-two-page',
        '  --binarization auto|otsu|sauvola|wolf',
        '  --no-normalize-illumination',
        '  --reading-order ltr|rtl',
        '  --thickness <number>',
        '  --despeckle-level off|cautious|normal|aggressive',
        '  --auto-dewarp [--auto-dewarp-depth <number>]',
        '  --skip-blank-pages',
    ].join('\n') + '\n');
}

function parsePageList(value: string) {
    const pages = new Set<number>();
    for (const token of value.split(',')) {
        const range = token.trim();
        if (!range) continue;
        const separator = range.indexOf('-');
        if (separator < 0) {
            const page = Number.parseInt(range, 10);
            if (!Number.isSafeInteger(page) || page < 1) {
                throw new Error(`Invalid page selector: ${range}`);
            }
            pages.add(page);
            continue;
        }
        const first = Number.parseInt(range.slice(0, separator), 10);
        const last = Number.parseInt(range.slice(separator + 1), 10);
        if (
            !Number.isSafeInteger(first)
            || !Number.isSafeInteger(last)
            || first < 1
            || last < first
        ) {
            throw new Error(`Invalid page range: ${range}`);
        }
        for (let page = first; page <= last; page += 1) pages.add(page);
    }
    if (pages.size === 0) throw new Error('The --pages selector is empty');
    return [...pages].sort((left, right) => left - right);
}

function parseMargins(value: string) {
    const values = value.split(',').map(item => Number.parseFloat(item.trim()));
    if (values.length === 1 && Number.isFinite(values[0])) {
        return {
            leftMm: values[0]!,
            topMm: values[0]!,
            rightMm: values[0]!,
            bottomMm: values[0]!,
        };
    }
    if (values.length !== 4 || values.some(valueItem => !Number.isFinite(valueItem))) {
        throw new Error(`Invalid margins: ${value}`);
    }
    return {
        leftMm: values[0]!,
        topMm: values[1]!,
        rightMm: values[2]!,
        bottomMm: values[3]!,
    };
}

function parseArguments(argv: readonly string[]): IScanCleanupCliArguments {
    const options: IScanCleanupOptions = {
        preserveOriginalQuality: false,
        layoutMode: 'auto',
        outputMode: 'auto',
        binarization: 'auto',
        normalizeIllumination: true,
        readingOrder: 'ltr',
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center',
        marginsMm: {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        },
        despeckleLevel: 'normal',
        autoDewarp: false,
        autoDewarpDepth: undefined,
        skipBlankPages: false,
        pageOverrides: {},
    };
    let sourcePdfPath: string | undefined;
    let outputPdfPath: string | undefined;
    let pages: number[] | undefined;
    const valueFor = (index: number, flag: string) => {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`${flag} requires a value`);
        }
        return value;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]!;
        if (argument === '--') continue;
        switch (argument) {
            case '--source':
                sourcePdfPath = resolve(valueFor(index, argument));
                index += 1;
                break;
            case '--out':
                outputPdfPath = resolve(valueFor(index, argument));
                index += 1;
                break;
            case '--no-crop-content':
                options.crop = false;
                break;
            case '--no-match-page-size':
                options.matchPageSize = false;
                break;
            case '--output-mode': {
                const value = valueFor(index, argument);
                const normalized = value === 'gray' ? 'grayscale' : value;
                if (![
                    'auto',
                    'bw',
                    'grayscale',
                    'color',
                    'mixed',
                ].includes(normalized)) {
                    throw new Error(`Invalid output mode: ${value}`);
                }
                options.outputMode = normalized as TScanCleanupOutputModeSetting;
                index += 1;
                break;
            }
            case '--pages':
                pages = parsePageList(valueFor(index, argument));
                index += 1;
                break;
            case '--preserve-original-quality':
                options.preserveOriginalQuality = true;
                break;
            case '--layout-mode': {
                const value = valueFor(index, argument);
                if (![
                    'auto',
                    'force-single',
                    'force-two-page',
                ].includes(value)) {
                    throw new Error(`Invalid layout mode: ${value}`);
                }
                options.layoutMode = value as IScanCleanupOptions['layoutMode'];
                index += 1;
                break;
            }
            case '--binarization': {
                const value = valueFor(index, argument);
                if (![
                    'auto',
                    'otsu',
                    'sauvola',
                    'wolf',
                ].includes(value)) {
                    throw new Error(`Invalid binarization method: ${value}`);
                }
                options.binarization = value as NonNullable<IScanCleanupOptions['binarization']>;
                index += 1;
                break;
            }
            case '--no-normalize-illumination':
                options.normalizeIllumination = false;
                break;
            case '--reading-order': {
                const value = valueFor(index, argument);
                if (value !== 'ltr' && value !== 'rtl') throw new Error(`Invalid reading order: ${value}`);
                options.readingOrder = value;
                index += 1;
                break;
            }
            case '--thickness': {
                const value = Number.parseFloat(valueFor(index, argument));
                if (!Number.isFinite(value) || value < -5 || value > 5) {
                    throw new Error(`Invalid thickness: ${String(value)}`);
                }
                options.thickness = value;
                index += 1;
                break;
            }
            case '--margins-mm':
                options.marginsMm = parseMargins(valueFor(index, argument));
                index += 1;
                break;
            case '--despeckle-level': {
                const value = valueFor(index, argument);
                if (![
                    'off',
                    'cautious',
                    'normal',
                    'aggressive',
                ].includes(value)) {
                    throw new Error(`Invalid despeckle level: ${value}`);
                }
                options.despeckleLevel = value as NonNullable<IScanCleanupOptions['despeckleLevel']>;
                index += 1;
                break;
            }
            case '--auto-dewarp':
                options.autoDewarp = true;
                break;
            case '--auto-dewarp-depth': {
                const value = Number.parseFloat(valueFor(index, argument));
                if (!Number.isFinite(value) || value < 0.5 || value > 4) {
                    throw new Error(`Invalid auto-dewarp depth: ${String(value)}`);
                }
                options.autoDewarpDepth = value;
                options.autoDewarp = true;
                index += 1;
                break;
            }
            case '--skip-blank-pages':
                options.skipBlankPages = true;
                break;
            case '--help':
            case '-h':
                printUsage();
                process.exitCode = 0;
                throw new Error('');
            default:
                throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (sourcePdfPath === undefined || outputPdfPath === undefined) {
        printUsage();
        throw new Error('--source and --out are required');
    }
    if (sourcePdfPath === outputPdfPath) throw new Error('--source and --out must differ');
    return {
        sourcePdfPath,
        outputPdfPath,
        ...(pages === undefined ? {} : {pages}),
        options,
    };
}

function resolveTool(binaryName: string, crateName: string, envName?: string) {
    const envOverride = envName === undefined ? undefined : process.env[envName];
    const resolved = resolveCliNativeToolPath(binaryName, crateName, process.cwd(), envOverride);
    if (resolved === null) throw new Error(`Native tool is unavailable: ${crateName}/${binaryName}`);
    return resolved;
}

function cliLog(level: 'debug' | 'warn' | 'error', message: string) {
    if (level !== 'debug' || process.env.EVB_SCAN_CLEANUP_CLI_DEBUG === '1') {
        process.stderr.write(`[scan-cleanup] ${level}: ${message}\n`);
    }
}

function nativeOptions(
    options: IScanCleanupRunCommandOptions | undefined,
    fallbackLog: TScanCleanupLog,
): IScanCleanupRunCommandOptions {
    return {
        ...(options ?? {}),
        log: options?.log ?? fallbackLog,
    };
}

async function identifyDimensions(
    magickBinary: string,
    inputPath: string,
    options: IScanCleanupRunCommandOptions,
) {
    const result = await runCliNativeToolCommand(
        magickBinary,
        [
            'identify',
            '-format',
            '%wx%h',
            inputPath,
        ],
        options,
    );
    const match = /^(\d+)x(\d+)$/u.exec(result.stdout.trim());
    if (!match) throw new Error(`Could not read image dimensions for ${inputPath}`);
    return {
        height: Number.parseInt(match[2]!, 10),
        width: Number.parseInt(match[1]!, 10),
    };
}

async function flattenLayeredManifestPage(
    parts: string[],
    pageDirectory: string,
    magickBinary: string,
    options: IScanCleanupRunCommandOptions,
) {
    const kind = parts[0]!;
    const backgroundPath = parts[4]!;
    const dimensions = await identifyDimensions(magickBinary, backgroundPath, options);
    const size = `${String(dimensions.width)}x${String(dimensions.height)}!`;
    const isAffine = kind === 'affine-masked-layered-jpeg';
    const foregroundPath = isAffine ? parts[5] : undefined;
    const maskPath = isAffine ? parts[6]! : parts[5]!;
    const decode = isAffine ? parts[13] : undefined;
    const foregroundColor = kind === 'layered-color-jpeg'
        ? `rgb(${parts[6]},${parts[7]},${parts[8]})`
        : 'black';
    const layerPath = join(pageDirectory, 'foreground.png');
    const layerInputs = foregroundPath === undefined
        ? [
            '-size',
            `${String(dimensions.width)}x${String(dimensions.height)}`,
            `xc:${foregroundColor}`,
        ]
        : [
            foregroundPath,
            '-resize',
            size,
        ];
    const maskInputs = [
        maskPath,
        '-resize',
        size,
    ];
    if (decode === 'inverted') maskInputs.push('-negate');
    await runCliNativeToolCommand(magickBinary, [
        ...layerInputs,
        ...maskInputs,
        '-alpha',
        'off',
        '-compose',
        'CopyOpacity',
        '-composite',
        layerPath,
    ], options);
    const flattenedPath = join(pageDirectory, 'flattened.png');
    await runCliNativeToolCommand(magickBinary, [
        backgroundPath,
        layerPath,
        '-compose',
        'Over',
        '-composite',
        flattenedPath,
    ], options);
    return flattenedPath;
}

function resolveWasmManifestPage(parts: string[]): ICliPdfCombineWasmPage | null {
    const kind = parts[0];
    const widthPoints = Number.parseFloat(parts[1] ?? '');
    const heightPoints = Number.parseFloat(parts[2] ?? '');
    if (
        !Number.isFinite(widthPoints)
        || widthPoints <= 0
        || !Number.isFinite(heightPoints)
        || heightPoints <= 0
    ) {
        return null;
    }
    if (kind === 'image-bilevel' && parts[3] !== undefined) {
        return {
            heightPoints,
            input: {
                kind: 'mask',
                imagePath: parts[3],
            },
            widthPoints,
        };
    }
    if (kind === 'image' && parts[3] !== undefined) {
        return {
            heightPoints,
            input: {
                kind: 'image',
                imagePath: parts[3],
            },
            widthPoints,
        };
    }
    if (kind === 'image-jpeg' && parts[4] !== undefined) {
        const jpegQuality = Number.parseInt(parts[3] ?? '', 10);
        return Number.isSafeInteger(jpegQuality) && jpegQuality > 0
            ? {
                heightPoints,
                input: {
                    kind: 'image',
                    imagePath: parts[4],
                },
                jpegQuality,
                widthPoints,
            }
            : null;
    }
    if (kind === 'layered-jpeg' && parts[5] !== undefined) {
        const jpegQuality = Number.parseInt(parts[3] ?? '', 10);
        return Number.isSafeInteger(jpegQuality) && jpegQuality > 0 && parts[4] !== undefined
            ? {
                heightPoints,
                input: {
                    backgroundPath: parts[4],
                    kind: 'layered',
                    maskPath: parts[5],
                },
                jpegQuality,
                widthPoints,
            }
            : null;
    }
    if (kind === 'layered-color-jpeg' && parts[8] !== undefined) {
        const jpegQuality = Number.parseInt(parts[3] ?? '', 10);
        const color = [
            Number.parseInt(parts[6] ?? '', 10),
            Number.parseInt(parts[7] ?? '', 10),
            Number.parseInt(parts[8] ?? '', 10),
        ];
        return Number.isSafeInteger(jpegQuality)
            && jpegQuality > 0
            && parts[4] !== undefined
            && parts[5] !== undefined
            && color.every(channel => Number.isSafeInteger(channel) && channel >= 0 && channel <= 255)
            ? {
                heightPoints,
                input: {
                    backgroundPath: parts[4],
                    foregroundColor: color as [number, number, number],
                    kind: 'layered-color',
                    maskPath: parts[5],
                },
                jpegQuality,
                widthPoints,
            }
            : null;
    }
    return null;
}

async function combineCliPagePdfs(
    pagePdfPaths: readonly string[],
    outputPath: string,
    qpdfBinary: string,
    options: IScanCleanupRunCommandOptions,
) {
    const qpdfArgs = [
        '--empty',
        '--pages',
        ...pagePdfPaths.flatMap(pagePath => [
            pagePath,
            '1',
        ]),
        '--',
        outputPath,
    ];
    await runCliNativeToolCommand(qpdfBinary, qpdfArgs, options);
}

async function runImageCombineFallback(
    outputPath: string,
    manifestPath: string,
    qpdfBinary: string,
    img2pdfBinary: string,
    magickBinary: string,
    options: IScanCleanupRunCommandOptions,
) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-combine-'));
    try {
        const lines = (await readFile(manifestPath, 'utf8'))
            .split(/\r?\n/u)
            .filter(line => line.trim().length > 0);
        const pagePdfPaths: string[] = [];
        for (const [
            index,
            line,
        ] of lines.entries()) {
            const parts = line.split('\t');
            const kind = parts[0];
            if (kind === undefined || parts[1] === undefined || parts[2] === undefined) {
                throw new Error(`Invalid scan-cleanup combine manifest line ${String(index + 1)}`);
            }
            const pagePdfPath = join(temporaryDirectory, `page-${String(index + 1)}.pdf`);
            const wasmPage = resolveWasmManifestPage(parts);
            let writtenWithWasm = false;
            if (wasmPage !== null) {
                try {
                    writtenWithWasm = await writeCliWasmPdfPage(
                        wasmPage,
                        pagePdfPath,
                        temporaryDirectory,
                        magickBinary,
                        index,
                        options,
                    );
                } catch (error) {
                    options.log?.('debug', `CLI PDF image combine WASM skipped page ${String(index + 1)}: ${String(error)}`);
                }
            }
            if (!writtenWithWasm) {
                let inputPath: string;
                if (
                    kind === 'layered-jpeg'
                    || kind === 'soft-layered-jpeg'
                    || kind === 'affine-masked-layered-jpeg'
                    || kind === 'layered-color-jpeg'
                ) {
                    inputPath = await flattenLayeredManifestPage(
                        parts,
                        temporaryDirectory,
                        magickBinary,
                        options,
                    );
                } else {
                    inputPath = parts.at(-1)!;
                }
                await runCliNativeToolCommand(img2pdfBinary, [
                    '--nodate',
                    '--pillow-limit-break',
                    '--pagesize',
                    `${parts[1]}ptx${parts[2]}pt`,
                    '--fit',
                    'fill',
                    '--output',
                    pagePdfPath,
                    inputPath,
                ], options);
            }
            pagePdfPaths.push(pagePdfPath);
            options.onStdout?.(JSON.stringify({
                processed: index + 1,
                total: lines.length,
                percent: (index + 1) / Math.max(1, lines.length) * 100,
                elapsedMs: 0,
                estimatedRemainingMs: null,
            }) + '\n');
        }
        await combineCliPagePdfs(pagePdfPaths, outputPath, qpdfBinary, options);
        return {
            exitCode: 0,
            stdout: '',
            stderr: '',
        } satisfies IScanCleanupProcessResult;
    } finally {
        await rm(temporaryDirectory, {
            force: true,
            recursive: true,
        });
    }
}

async function runPageOpsFallback(
    args: string[],
    qpdfBinary: string,
    options: IScanCleanupRunCommandOptions,
) {
    if (args[0] === 'page-sizes') {
        throw new Error('CLI page-ops fallback delegates page geometry to pdfinfo');
    }
    if (args[0] !== 'split-pages') throw new Error(`Unsupported CLI page-ops operation: ${args[0] ?? ''}`);
    const inputPath = args[args.indexOf('--input') + 1];
    const outputPath = args[args.indexOf('--output') + 1];
    const instructionsPath = args[args.indexOf('--instructions-file') + 1];
    if (!inputPath || !outputPath || !instructionsPath) throw new Error('Invalid CLI page-ops fallback arguments');
    const instructions = JSON.parse(await readFile(instructionsPath, 'utf8')) as {pages?: Array<{sourcePageIndex?: number}>;};
    const pages = instructions.pages ?? [];
    if (pages.length === 0) throw new Error('CLI page-ops fallback received no pages');
    const qpdfArgs = [
        '--empty',
        '--coalesce-contents',
        '--pages',
        ...pages.flatMap(page => [
            inputPath,
            String((page.sourcePageIndex ?? 0) + 1),
        ]),
        '--',
        outputPath,
    ];
    await runCliNativeToolCommand(qpdfBinary, qpdfArgs, options);
    return {
        exitCode: 0,
        stdout: '',
        stderr: '',
    } satisfies IScanCleanupProcessResult;
}

function createCliRetention(
    sourcePdfPath: string,
    revision: string,
    getPageCount: (path: string, signal: AbortSignal) => Promise<number>,
    getPageSizes: (path: string, signal: AbortSignal) => Promise<Awaited<ReturnType<typeof readPdfPageSizes>>>,
    detectRasterPages: (
        path: string,
        signal: AbortSignal,
        pages: readonly number[],
    ) => Promise<IScanCleanupDocumentRasterPages>,
): IScanCleanupDetectionRetention<IScanCleanupCliDocument> {
    return {
        async openDocument() {
            return {
                directory: await mkdtemp(join(tmpdir(), 'scan-cleanup-cli-document-')),
                sourcePdfPath,
            };
        },
        async pageCount(_document, signal) {
            return getPageCount(sourcePdfPath, signal);
        },
        async pageSizes(_document, signal) {
            return getPageSizes(sourcePdfPath, signal);
        },
        async rasterPages(_document, signal) {
            const totalPages = await getPageCount(sourcePdfPath, signal);
            return detectRasterPages(
                sourcePdfPath,
                signal,
                Array.from({length: totalPages}, (_, index) => index + 1),
            );
        },
        retainedPaths() {
            return Promise.resolve(new Map<number, IScanCleanupRetainedRaster>());
        },
        rasterScratchPath(document, pageNumber, dpi) {
            return Promise.resolve(join(document.directory, `page-${String(pageNumber)}-${String(dpi)}.png`));
        },
        retain(input) {
            return Promise.resolve({
                dpi: input.dpi,
                height: input.height,
                pageNumber: input.pageNumber,
                path: input.scratchPath,
                sizeBytes: input.sizeBytes,
                width: input.width,
            } satisfies IScanCleanupRetainedRaster);
        },
        async release(document) {
            await rm(document.directory, {
                force: true,
                recursive: true,
            });
        },
    };
}

function getProgressKey(progress: TScanCleanupProgress) {
    return `${progress.stage}:${String(progress.completedUnits)}:${String(progress.totalUnits)}`;
}

async function main() {
    const argumentsValue = parseArguments(process.argv.slice(2));
    const sourceStats = await stat(argumentsValue.sourcePdfPath);
    const qpdfBinary = resolveTool('qpdf', 'qpdf');
    const pdfinfoBinary = resolveTool('pdfinfo', 'poppler');
    const pdftoppmBinary = resolveTool('pdftoppm', 'poppler');
    const pdfimagesBinary = resolveTool('pdfimages', 'poppler');
    const scanCleanupBinary = resolveTool('evb-scan-cleanup', 'scan-cleanup', 'EVB_SCAN_CLEANUP_PATH');
    const img2pdfBinary = process.env.EVB_SCAN_CLEANUP_IMG2PDF_PATH ?? 'img2pdf';
    const magickBinary = process.env.EVB_SCAN_CLEANUP_MAGICK_PATH ?? 'magick';
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'scan-cleanup-cli-'));
    const detectionEvidenceDirectory = join(temporaryRoot, 'detection-evidence');
    const conversionEvidenceDirectory = join(temporaryRoot, 'conversion-evidence');
    await mkdir(detectionEvidenceDirectory, {recursive: true});
    await mkdir(conversionEvidenceDirectory, {recursive: true});
    const pageOpsBinary = PAGE_OPS_FALLBACK;
    const imageCombineBinary = IMAGE_COMBINE_FALLBACK;
    const log = cliLog satisfies TScanCleanupLog;
    const runCommand: TScanCleanupRunCommand = async (command, args, options) => {
        if (command === imageCombineBinary) {
            return runImageCombineFallback(
                args[args.indexOf('--output') + 1]!,
                args[args.indexOf('--compact-manifest') + 1]!,
                qpdfBinary,
                img2pdfBinary,
                magickBinary,
                nativeOptions(options, log),
            );
        }
        if (command === pageOpsBinary) {
            return runPageOpsFallback(args, qpdfBinary, nativeOptions(options, log));
        }
        return runCliNativeToolCommand(command, args, nativeOptions(options, log));
    };
    const renderers = createCliRenderers(runCommand);
    const getPageCount: TScanCleanupGetPageCount = async (pdfPath, options) => {
        const result = await runCommand(qpdfBinary, [
            '--show-npages',
            pdfPath,
        ], {
            allowedExitCodes: [
                0,
                3,
            ],
            commandLabel: 'qpdf(cli-page-count)',
            ...(options?.signal === undefined ? {} : {signal: options.signal}),
            log,
        });
        const pageCount = Number.parseInt(result.stdout.trim(), 10);
        if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error('Failed to read PDF page count');
        return pageCount;
    };
    const getPageSizes: TScanCleanupGetPageSizes = async (pdfPath, options: IReadPdfPageSizesOptions) =>
        readPdfPageSizes(pdfPath, {
            ...options,
            runCommand,
        });
    const detectSourceDpi = async (
        pdfPath: string,
        _pdfimages: string | undefined,
        sourceLog: TScanCleanupLog,
        commandEnv?: NodeJS.ProcessEnv,
        signal?: AbortSignal,
        pages?: readonly number[],
        onProgress?: (completedPages: number, totalPages: number) => void,
    ) => detectSourceDpiDetails(
        pdfPath,
        pdfimagesBinary,
        sourceLog,
        commandEnv,
        signal,
        pages,
        onProgress,
        runCommand,
    );
    const detectRasterPages = async (
        pdfPath: string,
        signal: AbortSignal,
        pages: readonly number[],
    ): Promise<IScanCleanupDocumentRasterPages> => {
        const result = await detectSourceDpi(
            pdfPath,
            pdfimagesBinary,
            log,
            undefined,
            signal,
            pages,
        );
        return {
            detected: true,
            pages: new Set(result.pageRasterByNumber.keys()),
            sourceDpiByPage: new Map(
                [...result.pageRasterByNumber].map(([
                    pageNumber,
                    raster,
                ]) => [
                    pageNumber,
                    raster.dpi,
                ] as const),
            ),
            bilevelLayerPages: new Set(
                [...result.pageRasterByNumber]
                    .filter(([
                        , raster,
                    ]) => raster.hasBilevelLayer)
                    .map(([pageNumber]) => pageNumber),
            ),
            backgroundDpiByPage: new Map(
                [...result.pageRasterByNumber].flatMap(([
                    pageNumber,
                    raster,
                ]) =>
                    raster.backgroundDpi === undefined
                        ? []
                        : [[
                            pageNumber,
                            raster.backgroundDpi,
                        ] as const],
                ),
            ),
        };
    };
    const getPageSizesForDetection = (pdfPath: string, signal: AbortSignal) =>
        getPageSizes(pdfPath, {
            pdfinfoBinary,
            log,
            runCommand,
            signal,
            tempDir: temporaryRoot,
        });
    const retention = createCliRetention(
        argumentsValue.sourcePdfPath,
        `${String(sourceStats.mtimeMs)}:${String(sourceStats.size)}`,
        (pdfPath, signal) => getPageCount(pdfPath, {signal}),
        getPageSizesForDetection,
        detectRasterPages,
    );
    const policy: IScanCleanupRuntimePolicy = {
        logicalCpus: availableParallelism(),
        rasterConcurrency: Math.max(1, Math.min(8, availableParallelism())),
        totalRamBytes: totalmem(),
    };
    const logProgress = (prefix: string) => {
        let previous = '';
        return (_results: IScanCleanupDetectionResult[], progress: TScanCleanupProgress) => {
            const key = getProgressKey(progress);
            if (key === previous) {
                return;
            }
            previous = key;
            process.stderr.write(
                `[scan-cleanup] ${prefix} ${progress.stage} ${String(progress.completedUnits)}/${String(progress.totalUnits)}\n`,
            );
        };
    };
    const startedAt = performance.now();
    try {
        process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR = detectionEvidenceDirectory;
        const detectionStartedAt = performance.now();
        const detectionDependencies: IScanCleanupDetectionDependencies = {
            getTempDir: () => temporaryRoot,
            getPdftoppmBinary: () => pdftoppmBinary,
            resolveBinary: () => scanCleanupBinary,
            renderPage: renderers.renderPage,
            renderPagePpm: renderers.renderPagePpm,
            createRasterPipes: async (paths, signal, pipeLog) => {
                await runCommand('mkfifo', [...paths], {
                    commandLabel: 'mkfifo(scan-cleanup-cli-detection-streams)',
                    log: pipeLog,
                    signal,
                });
            },
            runSidecar: runCliScanCleanupSidecar,
        };
        const detection = await runScanCleanupDetection(
            {
                ownerId: 'scan-cleanup-cli',
                documentRevision: `${String(sourceStats.mtimeMs)}:${String(sourceStats.size)}`,
                sourcePdfPath: argumentsValue.sourcePdfPath,
                options: argumentsValue.options,
            },
            new AbortController().signal,
            retention,
            detectionDependencies,
            policy,
            logProgress('detect'),
            log,
        );
        const detectionDurationMs = performance.now() - detectionStartedAt;
        const layoutByPage = Object.fromEntries(detection.results.map(result => [
            String(result.pageNumber),
            result.classification,
        ]));
        const pagePlanEvidenceByPage = Object.fromEntries(detection.results.flatMap(result =>
            result.pagePlanEvidence === undefined
                ? []
                : [[
                    String(result.pageNumber),
                    result.pagePlanEvidence,
                ] as const],
        ));
        const outputModeRecommendations = Object.fromEntries(detection.results.flatMap(result =>
            result.recommendedOutputMode === undefined
                ? []
                : [[
                    String(result.pageNumber),
                    result.recommendedOutputMode,
                ] as const],
        ));
        const softAlphaForegroundRecommendations = Object.fromEntries(detection.results.flatMap(result =>
            result.softAlphaForegroundRecommendation === undefined
                ? []
                : [[
                    String(result.pageNumber),
                    result.softAlphaForegroundRecommendation,
                ] as const],
        ));
        const sourcePageMetadataByPage = Object.fromEntries(detection.results.flatMap(result =>
            result.sourcePageMetadata === undefined
                ? []
                : [[
                    String(result.pageNumber),
                    result.sourcePageMetadata,
                ] as const],
        ));
        process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR = conversionEvidenceDirectory;
        const conversionStartedAt = performance.now();
        const conversionDependencies: IRunScanCleanupPipelineDependencies = {
            getPageCount,
            getPageSizes,
            detectSourceDpi,
            createRasterPipes: async (paths: readonly string[], signal: AbortSignal, pipeLog: TScanCleanupLog) => {
                await runCommand('mkfifo', [...paths], {
                    commandLabel: 'mkfifo(scan-cleanup-cli-raster-streams)',
                    log: pipeLog,
                    signal,
                });
            },
            renderPage: renderers.renderPage,
            renderPagePpm: renderers.renderPagePpm,
            runSidecar: runCliScanCleanupSidecar,
            runCommand,
            getAvailableScratchBytes: readAvailableScratchBytes,
            extractMrcLayers: async input => extractPdfMrcLayers({
                ...input,
                runCommand,
            }),
            requirePublishedRaster: requireCliPublishedRaster,
        };
        const paths: IScanCleanupWorkerPaths = {
            qpdfBinary,
            pdftoppmBinary,
            pdfimagesBinary,
            pdfinfoBinary,
            scanCleanupBinary,
            pdfImageCombineBinary: imageCombineBinary,
            pdfPageOpsBinary: pageOpsBinary,
            tempDir: temporaryRoot,
        };
        const request: IRunScanCleanupPipelineRequest = {
            sourcePdfPath: argumentsValue.sourcePdfPath,
            outputPdfPath: argumentsValue.outputPdfPath,
            options: argumentsValue.options,
            ...(argumentsValue.pages === undefined ? {} : {sourcePageNumbers: argumentsValue.pages}),
            layoutByPage,
            pagePlanEvidenceByPage,
            outputModeRecommendations,
            softAlphaForegroundRecommendations,
            sourcePageMetadataByPage,
        };
        const summary = await runScanCleanupConversion(
            request,
            paths,
            new AbortController().signal,
            progress => {
                const next = getProgressKey(progress);
                process.stderr.write(
                    `[scan-cleanup] convert ${next}\n`,
                );
            },
            policy,
            log,
            conversionDependencies,
        );
        const conversionDurationMs = performance.now() - conversionStartedAt;
        const outputStats = await stat(argumentsValue.outputPdfPath);
        const report = JSON.parse(await readFile(
            join(conversionEvidenceDirectory, 'scan-cleanup-representation-report.json'),
            'utf8',
        )) as IScanCleanupRepresentationReport;
        const summaryPath = `${argumentsValue.outputPdfPath}.summary.json`;
        const machineSummary = {
            source: argumentsValue.sourcePdfPath,
            output: argumentsValue.outputPdfPath,
            pages: summary.inputPages,
            outputPages: summary.outputPages,
            sourceBytes: sourceStats.size,
            outputBytes: outputStats.size,
            outputToSourceRatio: outputStats.size / sourceStats.size,
            timings: {
                detectionMs: detectionDurationMs,
                conversionMs: conversionDurationMs,
                totalMs: performance.now() - startedAt,
            },
            detection: {pages: detection.results.length},
            conversionSummary: summary,
            sourcePageToOutputPages: buildSourcePageToOutputPages(report.pages),
            perPageStreamSizes: report.pages,
            representation: {
                outputBytes: report.outputBytes,
                outputToSourceByteRatio: report.outputToSourceByteRatio,
            },
        };
        await writeFile(summaryPath, JSON.stringify(machineSummary, null, 2) + '\n');
        process.stderr.write(`[scan-cleanup] wrote ${summaryPath}\n`);
    } finally {
        delete process.env.EVB_SCAN_CLEANUP_EVIDENCE_DIR;
        await rm(temporaryRoot, {
            force: true,
            recursive: true,
        });
    }
}

void main().catch(error => {
    if (error instanceof Error && error.message === '') {
        return;
    }
    process.stderr.write(`[scan-cleanup] error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
