import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {createScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {resolveCliNativeToolPath} from '@scripts/scanCleanupCliAdapters';
import {
    SCAN_CLEANUP_CORE_BUILD_ID,
    SCAN_CLEANUP_STAMP_SCHEMA_ID,
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
    resolveEffectiveScanCleanupOptions,
    sha256ScanCleanupFile,
} from '@scan-cleanup-core/index';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const auditScript = join(projectRoot, 'scripts/diagnostics/scan-cleanup-word-loss-audit.mjs');
const qpdfBinary = resolveCliNativeToolPath('qpdf', 'qpdf', projectRoot) ?? 'qpdf';

function buildMinimalPdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 32 32] /Resources << >> >>',
        '<< /Producer (evb-viewer-test) >>',
    ];
    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((content, index) => {
        offsets.push(body.length);
        body += `${String(index + 1)} 0 obj\n${content}\nendobj\n`;
    });
    const xrefOffset = body.length;
    body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
    for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
    return Buffer.from(body, 'latin1');
}

interface ISyntheticRaster {
    bitsPerComponent: number;
    height: number;
    imageMask?: boolean;
    pixels: Uint8Array;
    width: number;
}

type TSyntheticCleanedVariant =
    | 'attached-fringe'
    | 'equal'
    | 'invented'
    | 'scaled-islands'
    | 'scaled-local-shift'
    | 'thick';

function buildRasterPdf({
    bitsPerComponent,
    height,
    imageMask,
    pixels,
    width,
}: ISyntheticRaster) {
    const content = Buffer.from(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`, 'ascii');
    const imageDictionary = imageMask
        ? [
            `<< /Type /XObject /Subtype /Image /Width ${String(width)} /Height ${String(height)}`,
            `/ImageMask true /BitsPerComponent 1 /Decode [1 0] /Length ${String(pixels.length)} >>`,
        ].join(' ')
        : [
            `<< /Type /XObject /Subtype /Image /Width ${String(width)} /Height ${String(height)}`,
            `/ColorSpace /DeviceGray /BitsPerComponent ${String(bitsPerComponent)} /Length ${String(pixels.length)} >>`,
        ].join(' ');
    const imageStream = Buffer.concat([
        Buffer.from(`${imageDictionary}\nstream\n`, 'ascii'),
        Buffer.from(pixels),
        Buffer.from('\nendstream', 'ascii'),
    ]);
    const contentStream = Buffer.concat([
        Buffer.from(`<< /Length ${String(content.length)} >>\nstream\n`, 'ascii'),
        content,
        Buffer.from('endstream', 'ascii'),
    ]);
    const objects = [
        Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
        Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
        Buffer.from([
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(width)} ${String(height)}]`,
            '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
        ].join(' '), 'ascii'),
        contentStream,
        imageStream,
        Buffer.from('<< /Producer (evb-stage26-synthetic) >>', 'ascii'),
    ];
    const chunks = [Buffer.from('%PDF-1.4\n', 'ascii')];
    const offsets: number[] = [];
    for (const [
        index,
        object,
    ] of objects.entries()) {
        offsets.push(chunks.reduce((total, chunk) => total + chunk.length, 0));
        chunks.push(
            Buffer.from(`${String(index + 1)} 0 obj\n`, 'ascii'),
            object,
            Buffer.from('\nendobj\n', 'ascii'),
        );
    }
    const xrefOffset = chunks.reduce((total, chunk) => total + chunk.length, 0);
    chunks.push(Buffer.from(`xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`, 'ascii'));
    for (const offset of offsets) {
        chunks.push(Buffer.from(`${String(offset).padStart(10, '0')} 00000 n \n`, 'ascii'));
    }
    chunks.push(Buffer.from([
        `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info 6 0 R >>`,
        `startxref\n${String(xrefOffset)}\n%%EOF\n`,
    ].join('\n'), 'ascii'));
    return Buffer.concat(chunks);
}

function packBilevelRaster(width: number, height: number, isBlack: (x: number, y: number) => boolean) {
    const rowBytes = Math.ceil(width / 8);
    const packed = new Uint8Array(rowBytes * height).fill(255);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (isBlack(x, y)) {
                const byteIndex = y * rowBytes + (x >> 3);
                packed[byteIndex] = (packed[byteIndex] ?? 0) & ~(1 << (7 - (x & 7)));
            }
        }
    }
    return packed;
}

function buildSyntheticSourceRaster(
    bitsPerComponent = 8,
    variant: TSyntheticCleanedVariant = 'equal',
): ISyntheticRaster {
    const width = 160;
    const height = 160;
    const pixels = new Uint8Array(width * height).fill(255);
    if (variant === 'attached-fringe') {
        for (let y = 30; y < 130; y += 1) {
            for (let x = 20; x < 140; x += 1) {
                pixels[y * width + x] = 40;
            }
        }
    } else {
        for (const left of [
            24,
            76,
            128,
        ]) {
            for (let y = 32; y < 56; y += 1) {
                for (let x = left; x < left + 10; x += 1) {
                    pixels[y * width + x] = 40;
                }
            }
        }
    }
    return {
        bitsPerComponent,
        height,
        pixels: bitsPerComponent === 1
            ? packBilevelRaster(width, height, (x, y) => pixels[y * width + x]! < 128)
            : pixels,
        width,
    };
}

function buildSyntheticCleanedRaster(
    source: ISyntheticRaster,
    variant: TSyntheticCleanedVariant,
    scale = 1,
    imageMask = true,
) {
    const width = source.width * scale;
    const height = source.height * scale;
    const pixels = new Uint8Array(width * height);
    const setPixel = (x: number, y: number) => {
        if (x >= 0 && x < width && y >= 0 && y < height) {
            pixels[y * width + x] = 1;
        }
    };
    const sourceLefts = [
        24,
        76,
        128,
    ];
    if (variant === 'attached-fringe') {
        for (let y = 30 * scale; y < 130 * scale; y += 1) {
            for (let x = 20 * scale; x < 160 * scale; x += 1) {
                setPixel(x, y);
            }
        }
    } else {
        for (const [
            index,
            sourceLeft,
        ] of sourceLefts.entries()) {
            const thickness = variant === 'thick' ? 2 : 0;
            const localShift = variant === 'scaled-local-shift' && index === 0 ? 14 : 0;
            const left = sourceLeft * scale - thickness + localShift;
            const top = 32 * scale - thickness;
            const right = (sourceLeft + 10) * scale + thickness + localShift;
            const bottom = 56 * scale + thickness;
            for (let y = top; y < bottom; y += 1) {
                for (let x = left; x < right; x += 1) {
                    setPixel(x, y);
                }
            }
        }
    }
    if (variant === 'invented') {
        for (let y = 86 * scale; y < 106 * scale; y += 1) {
            for (let x = 72 * scale; x < 136 * scale; x += 1) {
                setPixel(x, y);
            }
        }
    }
    if (variant === 'scaled-islands') {
        const islands = [
            [
                100,
                180,
                20,
                30,
            ],
            [
                200,
                180,
                30,
                30,
            ],
        ] as const;
        for (const [
            left,
            top,
            islandWidth,
            islandHeight,
        ] of islands) {
            for (let y = top; y < top + islandHeight; y += 1) {
                for (let x = left; x < left + islandWidth; x += 1) {
                    setPixel(x, y);
                }
            }
        }
    }
    return {
        bitsPerComponent: 1,
        height,
        imageMask,
        pixels: packBilevelRaster(width, height, (x, y) => pixels[y * width + x] === 1),
        width,
    };
}

interface IQpdfJsonEntry {[key: string]: unknown;}

interface IQpdfJson {qpdf: IQpdfJsonEntry[];}

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    binarization: 'auto',
    normalizeIllumination: true,
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
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};

interface IRunAuditOptions {
    failOn?: 'any' | 'invented-ink' | 'none' | 'silhouette' | 'text-loss';
    verifyStamp?: boolean;
}

async function runAudit(
    source: string,
    cleaned: string,
    output: string,
    {
        failOn = 'none',
        verifyStamp = true,
    }: IRunAuditOptions = {},
) {
    try {
        const args = [
            auditScript,
            '--source',
            source,
            '--cleaned',
            cleaned,
            '--out',
            output,
            '--fail-on',
            failOn,
            '--workers',
            '1',
            ...(verifyStamp ? ['--verify-stamp'] : []),
        ];
        await execFileAsync(process.execPath, args, {
            cwd: projectRoot,
            maxBuffer: 2 * 1024 * 1024,
        });
        return 0;
    } catch (error) {
        return (error as {code?: number}).code ?? 1;
    }
}

async function injectStamp(source: string, output: string, stampHex: string, updatePath: string) {
    const qpdfJson = JSON.parse(
        (await execFileAsync(qpdfBinary, [
            '--json',
            '--object-streams=disable',
            source,
            '-',
        ])).stdout,
    ) as IQpdfJson;
    const trailerEntry = qpdfJson.qpdf.find(entry => entry.trailer !== undefined);
    const trailer = trailerEntry?.trailer as IQpdfJsonEntry | undefined;
    const trailerValue = trailer?.value as IQpdfJsonEntry | undefined;
    const infoReference = trailerValue?.['/Info'];
    if (typeof infoReference !== 'string') throw new Error('test PDF has no qpdf Info reference');
    const infoEntry = qpdfJson.qpdf.find(entry => Object.hasOwn(entry, `obj:${infoReference}`));
    const infoObject = infoEntry?.[`obj:${infoReference}`] as IQpdfJsonEntry | undefined;
    const infoValue = infoObject?.value as IQpdfJsonEntry | undefined;
    if (infoValue === undefined) throw new Error('test PDF has no qpdf Info object');
    infoValue['/EVBScanCleanup'] = `u:${stampHex}`;
    await writeFile(updatePath, JSON.stringify(qpdfJson));
    await execFileAsync(qpdfBinary, [
        `--update-from-json=${updatePath}`,
        source,
        output,
    ]);
}

describe('scan-cleanup word-loss audit stamp verification', () => {
    it('reports an unstamped baseline and accepts a qpdf-injected core stamp', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-stamp-audit-'));
        try {
            const source = join(temporaryDirectory, 'source.pdf');
            const cleaned = join(temporaryDirectory, 'cleaned.pdf');
            const update = join(temporaryDirectory, 'update.json');
            const baselineReport = join(temporaryDirectory, 'baseline.json');
            const stampedReport = join(temporaryDirectory, 'stamped.json');
            await writeFile(source, buildMinimalPdf());

            expect(await runAudit(source, source, baselineReport)).toBe(1);
            expect(JSON.parse(await readFile(baselineReport, 'utf8')).stampVerification).toMatchObject({status: 'unstamped'});

            const resolved = resolveEffectiveScanCleanupOptions({
                options,
                pageOverride: createScanCleanupPageOverride(),
                dpi: 300,
                qualityPath: 'raster',
            });
            const effectiveRecord = {
                sourcePage: 1,
                options: materializeScanCleanupStampOptions({
                    nativeOptions: resolved,
                    options,
                    qualityPath: 'raster',
                }),
            };
            const stamp = buildScanCleanupProvenanceStamp({
                sourceSha256: await sha256ScanCleanupFile(source),
                effectiveOptions: [effectiveRecord],
                outputMappings: [{
                    sourcePage: 1,
                    half: 'full',
                    outputOrdinal: 1,
                    rotationDegrees: 0,
                    excluded: false,
                    blank: false,
                }],
                pagePlanDigests: [buildScanCleanupPagePlanDigest(
                    1,
                    effectiveRecord.options,
                    {sourcePage: 1},
                )],
                buildIds: {
                    coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
                    coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
                    nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
                    assemblerBackend: 'source-preserved',
                    transportMode: 'source-preserved',
                },
            });
            await injectStamp(
                source,
                cleaned,
                encodeScanCleanupProvenanceStampHex(stamp),
                update,
            );

            expect(await runAudit(source, cleaned, stampedReport)).toBe(0);
            expect(JSON.parse(await readFile(stampedReport, 'utf8')).stampVerification).toMatchObject({status: 'valid'});
        } finally {
            await rm(temporaryDirectory, {
                force: true,
                recursive: true,
            });
        }
    }, 30_000);
});

describe('scan-cleanup invented-ink audit', () => {
    async function runSyntheticCase(
        variant: TSyntheticCleanedVariant,
        {
            canonicalGeometry = false,
            cleanedImageMask = true,
            mapped = false,
            scale = 1,
            sourceBitsPerComponent = 8,
        } = {},
    ) {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), `scan-cleanup-invented-${variant}-`));
        const source = join(temporaryDirectory, 'source.pdf');
        const cleaned = join(temporaryDirectory, 'cleaned.pdf');
        const reportPath = join(temporaryDirectory, 'report.json');
        const sourceRaster = buildSyntheticSourceRaster(sourceBitsPerComponent, variant);
        await writeFile(source, buildRasterPdf(sourceRaster));
        await writeFile(
            cleaned,
            buildRasterPdf(buildSyntheticCleanedRaster(
                sourceRaster,
                variant,
                scale,
                cleanedImageMask,
            )),
        );
        if (mapped) {
            const mapping = {
                sourcePageToOutputPages: {'1': [1]},
                ...(canonicalGeometry
                    ? {perPageStreamSizes: [{
                        outputPageNumber: 1,
                        renderGeometry: {
                            canvasHeightPx: sourceRaster.height * scale,
                            canvasWidthPx: sourceRaster.width * scale,
                            cropRect: {
                                heightPx: sourceRaster.height,
                                widthPx: sourceRaster.width,
                                xPx: 0,
                                yPx: 0,
                            },
                            dewarped: false,
                            forwardTransform: {matrix: [
                                [
                                    1,
                                    0,
                                    0,
                                ],
                                [
                                    0,
                                    1,
                                    0,
                                ],
                                [
                                    0,
                                    0,
                                    1,
                                ],
                            ]},
                            inputHeightPx: sourceRaster.height,
                            inputWidthPx: sourceRaster.width,
                            matchedCanvasContentHeightPx: sourceRaster.height * scale,
                            matchedCanvasContentWidthPx: sourceRaster.width * scale,
                            outputHeightPx: sourceRaster.height * scale,
                            outputWidthPx: sourceRaster.width * scale,
                            placementOffsetXPx: 0,
                            placementOffsetYPx: 0,
                        },
                    }]}
                    : {}),
            };
            await writeFile(`${cleaned}.summary.json`, JSON.stringify(mapping));
        }
        const exitCode = await runAudit(source, cleaned, reportPath, {
            failOn: 'any',
            verifyStamp: false,
        });
        const report = JSON.parse(await readFile(reportPath, 'utf8')) as {pages: Array<{
            alignment?: {
                attemptedScales?: string[];
                scale?: string;
                scaleX?: number;
                scaleY?: number;
            };
            auditDilationRadius?: number;
            components?: Array<{
                area?: number;
                bbox?: {
                    height?: number;
                    width?: number;
                };
                classification?: string;
                unsupportedFraction?: number;
            }>;
            damagedCount?: number;
            flagged?: boolean;
            inventedCount?: number;
            inventedFlagged?: boolean;
            inventedInkFraction?: number;
            inventedSourceSupport?: {
                alignmentRadiusPx?: number;
                minimumComponentArea?: number;
                minimumUnsupportedComponentArea?: number;
            };
            localRealignment?: {
                improvedComponents?: number;
                maxShiftDistance?: number;
                radiusPx?: number;
            };
            lostCount?: number;
        }>;};
        await rm(temporaryDirectory, {
            force: true,
            recursive: true,
        });
        const page = report.pages[0];
        if (!page) {
            throw new Error('Synthetic audit did not return a page row');
        }
        return {
            exitCode,
            page,
        };
    }

    it('flags a solid cleaned-page bar with no source-raw support', async () => {
        const result = await runSyntheticCase('invented');

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            flagged: true,
            inventedCount: 1,
            inventedFlagged: true,
        });
        expect(result.page.inventedInkFraction).toBeGreaterThan(0);
        expect(result.page.components).toEqual(expect.arrayContaining([expect.objectContaining({
            bbox: expect.objectContaining({
                height: 20,
                width: 64,
            }),
            classification: 'invented',
            unsupportedFraction: 1,
        })]));
    }, 30_000);

    it('keeps a cleaned page that only thickens existing strokes clean', async () => {
        const result = await runSyntheticCase('thick');

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            flagged: false,
            inventedCount: 0,
            inventedFlagged: false,
            inventedInkFraction: 0,
        });
    }, 30_000);

    it('does not call a mostly supported component with a resampled fringe invented', async () => {
        const result = await runSyntheticCase('attached-fringe', {mapped: true});

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            flagged: false,
            inventedCount: 0,
            inventedFlagged: false,
        });
        expect(result.page.components).toBeUndefined();
    }, 30_000);

    it('keeps a cleaned page equal to source clean', async () => {
        const result = await runSyntheticCase('equal');

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            flagged: false,
            inventedCount: 0,
            inventedFlagged: false,
            inventedInkFraction: 0,
        });
    }, 30_000);

    it('normalizes 2x mapped bilevel tolerances without hiding an invented physical bar', async () => {
        const mappedOptions = {
            mapped: true,
            scale: 2,
            sourceBitsPerComponent: 1,
        };
        for (const variant of [
            'equal',
            'thick',
        ] as const) {
            const result = await runSyntheticCase(variant, mappedOptions);
            expect(result.exitCode).toBe(0);
            expect(result.page).toMatchObject({
                alignment: {
                    attemptedScales: expect.arrayContaining(['uniform-fit(2.000000)']),
                    scaleX: 2,
                },
                auditDilationRadius: 2,
                damagedCount: 0,
                flagged: false,
                inventedCount: 0,
                inventedFlagged: false,
                inventedSourceSupport: {
                    alignmentRadiusPx: 16,
                    minimumUnsupportedComponentArea: 800,
                },
                lostCount: 0,
            });
        }

        const invented = await runSyntheticCase('invented', mappedOptions);
        expect(invented.exitCode).toBe(1);
        expect(invented.page).toMatchObject({
            alignment: {
                attemptedScales: expect.arrayContaining(['uniform-fit(2.000000)']),
                scaleX: 2,
            },
            auditDilationRadius: 2,
            flagged: true,
            inventedCount: 1,
            inventedFlagged: true,
        });
        expect(invented.page.components).toEqual(expect.arrayContaining([expect.objectContaining({
            bbox: expect.objectContaining({
                height: 40,
                width: 128,
            }),
            classification: 'invented',
        })]));
    }, 30_000);

    it('uses canonical geometry and bit depth for a mapped 1-bit image', async () => {
        const result = await runSyntheticCase('equal', {
            canonicalGeometry: true,
            cleanedImageMask: false,
            mapped: true,
            scale: 2,
            sourceBitsPerComponent: 1,
        });

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            alignment: {
                attemptedScales: ['canonical-geometry(2.000000x2.000000)'],
                scaleX: 2,
                scaleY: 2,
            },
            auditDilationRadius: 2,
            flagged: false,
            inventedCount: 0,
            lostCount: 0,
        });
    }, 30_000);

    it('uses output-grid areas so only the larger unsupported 2x island flags', async () => {
        const result = await runSyntheticCase('scaled-islands', {
            mapped: true,
            scale: 2,
        });

        expect(result.exitCode).toBe(1);
        expect(result.page).toMatchObject({
            alignment: {
                scaleX: 2,
                scaleY: 2,
            },
            inventedCount: 1,
            inventedFlagged: true,
            inventedSourceSupport: {
                alignmentRadiusPx: 16,
                minimumComponentArea: 96,
                minimumUnsupportedComponentArea: 800,
            },
        });
        expect(result.page.components).toEqual(expect.arrayContaining([
            expect.objectContaining({
                area: 600,
                bbox: expect.objectContaining({
                    height: 30,
                    width: 20,
                }),
                classification: 'ignored-dust',
            }),
            expect.objectContaining({
                area: 900,
                bbox: expect.objectContaining({
                    height: 30,
                    width: 30,
                }),
                classification: 'invented',
            }),
        ]));
    }, 30_000);

    it('scales local component tolerance and dilation on a fitted 2x grid', async () => {
        const result = await runSyntheticCase('scaled-local-shift', {
            mapped: true,
            scale: 2,
        });

        expect(result.exitCode).toBe(0);
        expect(result.page).toMatchObject({
            alignment: {
                scaleX: 2,
                scaleY: 2,
            },
            auditDilationRadius: 2,
            flagged: false,
            inventedCount: 0,
            localRealignment: {radiusPx: 16},
        });
        expect(result.page.localRealignment?.improvedComponents).toBeGreaterThan(0);
        expect(result.page.localRealignment?.maxShiftDistance).toBeGreaterThan(8);
    }, 30_000);
});
