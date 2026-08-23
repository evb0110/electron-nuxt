import {createHash} from 'node:crypto';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    SCAN_CLEANUP_WARNING_EVENT_CODES,
    type TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    SCAN_CLEANUP_PARITY_CANVAS_DPI,
    SCAN_CLEANUP_PARITY_CASES,
    SCAN_CLEANUP_PARITY_FIXTURES,
    SCAN_CLEANUP_PARITY_PATHS,
    SCAN_CLEANUP_PARITY_REQUIREMENTS,
    SCAN_CLEANUP_PARITY_TOLERANCE_MM,
    SCAN_CLEANUP_PARITY_TOLERANCE_RASTER_PIXELS,
    SCAN_CLEANUP_PARITY_UNIT,
    SCAN_CLEANUP_PARITY_WARNING_COMPARISON_POLICY,
    assertScanCleanupParityIdentities,
    assertScanCleanupParityReport,
    attributeScanCleanupParityWarningEvents,
    buildScanCleanupParityIdentities,
    buildScanCleanupParityReport,
    compareScanCleanupParityObservations,
    mapScanCleanupParityAnalysisRectToPdfPoints,
    millimetresFromPixels,
    millimetresFromPoints,
    normalizeScanCleanupParityCanvasPixelObservation,
    normalizeScanCleanupParityPointsObservation,
    presentScanCleanupParityPageSpaceRect,
    resolveScanCleanupParityCoverageGaps,
    scanCleanupParityWarningSignature,
    type IScanCleanupParityCanvasPixelSource,
    type IScanCleanupParityCapturedWarningEvent,
    type IScanCleanupParityCase,
    type IScanCleanupParityFixtureIdentity,
    type IScanCleanupParityObservation,
    type IScanCleanupParityPageSpaceRect,
    type IScanCleanupParityPointsSource,
    type TScanCleanupParityFixture,
} from '@tests/helpers/scanCleanupParityCorpus';

const LETTER_WIDTH_POINTS = 612;
const LETTER_HEIGHT_POINTS = 792;
const CANVAS_WIDTH_PX = LETTER_WIDTH_POINTS / 72 * SCAN_CLEANUP_PARITY_CANVAS_DPI;
const CANVAS_HEIGHT_PX = LETTER_HEIGHT_POINTS / 72 * SCAN_CLEANUP_PARITY_CANVAS_DPI;
const DEFAULT_PARITY_CASE_ID = 'ordinary-margins';

function canvasPixelSource(overrides: {
    caseId?: string;
    metadata?: Partial<IScanCleanupParityCanvasPixelSource['metadata']>;
} = {}): IScanCleanupParityCanvasPixelSource {
    return {
        caseId: overrides.caseId ?? DEFAULT_PARITY_CASE_ID,
        path: 'raster-final',
        canvasGrid: 'raster-canvas',
        sourcePageNumber: 1,
        outputOrdinal: 0,
        sourceRotationDegrees: 0,
        requestedMarginsMm: {
            leftMm: 10,
            topMm: 10,
            rightMm: 10,
            bottomMm: 10,
        },
        requestedAlignment: 'top-center',
        metadata: {
            half: 'full',
            rotationDegrees: 0,
            sourceDpi: SCAN_CLEANUP_PARITY_CANVAS_DPI,
            canvasWidthPx: CANVAS_WIDTH_PX,
            canvasHeightPx: CANVAS_HEIGHT_PX,
            matchedCanvasTargetWidthPoints: LETTER_WIDTH_POINTS,
            matchedCanvasTargetHeightPoints: LETTER_HEIGHT_POINTS,
            matchedCanvasContentWidthPx: 600,
            matchedCanvasContentHeightPx: 800,
            outputWidthPx: 600,
            outputHeightPx: 800,
            placementOffsetXPx: 100,
            placementOffsetYPx: 57,
            appliedMargins: {
                leftPx: 57,
                topPx: 57,
                rightPx: 57,
                bottomPx: 57,
            },
            warningEvents: [],
            warnings: [],
            ...overrides.metadata,
        },
        publishesTypedWarningEvents: true,
    };
}

function rasterObservation(overrides: {
    caseId?: string;
    placementOffsetXPx?: number;
    placementOffsetYPx?: number;
    contentWidthPx?: number;
    contentHeightPx?: number;
} = {}) {
    return normalizeScanCleanupParityCanvasPixelObservation(canvasPixelSource({
        caseId: overrides.caseId ?? DEFAULT_PARITY_CASE_ID,
        metadata: {
            matchedCanvasContentWidthPx: overrides.contentWidthPx ?? 600,
            matchedCanvasContentHeightPx: overrides.contentHeightPx ?? 800,
            outputWidthPx: overrides.contentWidthPx ?? 600,
            outputHeightPx: overrides.contentHeightPx ?? 800,
            placementOffsetXPx: overrides.placementOffsetXPx ?? 100,
            placementOffsetYPx: overrides.placementOffsetYPx ?? 57,
        },
    }));
}

function pointsSource(): IScanCleanupParityPointsSource {
    return {
        caseId: DEFAULT_PARITY_CASE_ID,
        sourcePageNumber: 1,
        outputOrdinal: 0,
        half: 'full',
        sourceRotationDegrees: 0,
        rotationDegrees: 0,
        sourceDpi: SCAN_CLEANUP_PARITY_CANVAS_DPI,
        canvasDpi: 300,
        requestedMarginsMm: {
            leftMm: 10,
            topMm: 10,
            rightMm: 10,
            bottomMm: 10,
        },
        requestedAlignment: 'top-center',
        canvasPoints: {
            widthPoints: LETTER_WIDTH_POINTS,
            heightPoints: LETTER_HEIGHT_POINTS,
        },
        contentPoints: {
            // The same 600x800 canvas pixels the raster observation places.
            xPoints: 100 / SCAN_CLEANUP_PARITY_CANVAS_DPI * 72,
            yTopPoints: 57 / SCAN_CLEANUP_PARITY_CANVAS_DPI * 72,
            widthPoints: 600 / SCAN_CLEANUP_PARITY_CANVAS_DPI * 72,
            heightPoints: 800 / SCAN_CLEANUP_PARITY_CANVAS_DPI * 72,
        },
        warningEvents: null,
        warningMessages: [],
    };
}

function losslessObservationAt(offsetPoints: number) {
    const source = pointsSource();
    return normalizeScanCleanupParityPointsObservation({
        ...source,
        contentPoints: {
            ...source.contentPoints,
            xPoints: offsetPoints,
        },
    });
}

const LOSSLESS_TYPED_WARNING_BLOCKER = {
    path: 'lossless-final' as const,
    reason: 'The lossless assembler formats every condition inside the conversion child process.',
};

function fixtureIdentity(fixture: TScanCleanupParityFixture, index: number): IScanCleanupParityFixtureIdentity {
    return {
        fixture,
        fileName: `parity-${fixture}.pdf`,
        sha256: String(index).repeat(64).slice(0, 64),
        bytes: 1024 + index,
        pageCount: 2,
    };
}

/**
 * A report whose shape matches a real run: every declared fixture identified,
 * every case present and every requirement covered. Negative cases mutate a
 * copy of it, so each one fails for the single reason it introduces.
 */
function corpusReport(
    cases: readonly IScanCleanupParityCase[] = SCAN_CLEANUP_PARITY_CASES,
    fixtures: readonly IScanCleanupParityFixtureIdentity[] = SCAN_CLEANUP_PARITY_FIXTURES.map(
        (fixture, index) => fixtureIdentity(fixture, index + 1),
    ),
) {
    return buildScanCleanupParityReport({
        fixtures,
        typedWarningChannelLimitations: [LOSSLESS_TYPED_WARNING_BLOCKER],
        cases: cases.map(parityCase => ({
            parityCase,
            fixtureSha256: fixtures.find(entry => entry.fixture === parityCase.fixture)!.sha256,
            observations: [
                rasterObservation({caseId: parityCase.id}),
                {
                    ...rasterObservation({caseId: parityCase.id}),
                    path: 'lossless-final' as const,
                    warningEvents: null,
                },
            ],
        })),
    });
}

/**
 * A retained-evidence tree as a run leaves it: the fixture documents, the
 * engine binary and the report file, each carrying the bytes its identity
 * claims. The validator re-reads these files, so a negative case corrupts the
 * tree rather than the record and still has to be caught.
 */
function identityEvidenceTree() {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'scan-cleanup-parity-identities-'));
    const writeEvidence = (fileName: string, contents: string) => {
        const path = join(fixtureDir, fileName);
        writeFileSync(path, contents, 'utf8');
        return {
            path,
            sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
            bytes: statSync(path).size,
        };
    };
    const fixtures = SCAN_CLEANUP_PARITY_FIXTURES.map((fixture, index) => {
        const fileName = `parity-${fixture}.pdf`;
        const written = writeEvidence(fileName, `%PDF-1.7 ${fixture} ${String(index)}\n`);
        return {
            fixture,
            fileName,
            sha256: written.sha256,
            bytes: written.bytes,
            pageCount: 2,
        };
    });
    const engineFile = writeEvidence('evb-scan-cleanup', 'engine bytes\n');
    const report = corpusReport(SCAN_CLEANUP_PARITY_CASES, fixtures);
    const reportFile = writeEvidence(
        'parity-corpus-report.json',
        `${JSON.stringify(report, null, 2)}\n`,
    );
    return {
        engineFile,
        reportFile,
        report,
        sources: {fixtureDir},
        identities: buildScanCleanupParityIdentities({
            engines: [{
                binaryName: 'evb-scan-cleanup',
                path: engineFile.path,
                sha256: engineFile.sha256,
                bytes: engineFile.bytes,
            }],
            report,
            reportPath: reportFile.path,
            reportSha256: reportFile.sha256,
            reportBytes: reportFile.bytes,
            fixtureDir,
        }),
        remove: () => rmSync(fixtureDir, {
            recursive: true,
            force: true,
        }),
    };
}

describe('scan cleanup parity corpus', () => {
    it('covers every placement condition SC-IMP-004 requires', () => {
        expect(resolveScanCleanupParityCoverageGaps()).toEqual([]);
        // Cases are the unit of evidence, so two cases cannot claim one id.
        expect(new Set(SCAN_CLEANUP_PARITY_CASES.map(entry => entry.id)).size)
            .toBe(SCAN_CLEANUP_PARITY_CASES.length);
        // Every requirement a case claims, and every fixture it names, has to
        // be one the corpus declares.
        for (const parityCase of SCAN_CLEANUP_PARITY_CASES) {
            expect(SCAN_CLEANUP_PARITY_FIXTURES).toContain(parityCase.fixture);
            for (const requirement of parityCase.covers) {
                expect(SCAN_CLEANUP_PARITY_REQUIREMENTS).toContain(requirement);
            }
        }
        expect(resolveScanCleanupParityCoverageGaps(
            SCAN_CLEANUP_PARITY_CASES.filter(entry => entry.id !== 'split-leaves'),
        )).toEqual(['split-leaves']);
    });

    it('declares one physical unit and the three fitter paths it compares', () => {
        expect(SCAN_CLEANUP_PARITY_UNIT).toBe('mm');
        expect(SCAN_CLEANUP_PARITY_PATHS).toEqual([
            'raster-final',
            'lossless-final',
            'preview',
        ]);
    });

    it('fixes the tolerance at one raster canvas pixel of the selected DPI', () => {
        expect(SCAN_CLEANUP_PARITY_TOLERANCE_RASTER_PIXELS).toBe(1);
        expect(SCAN_CLEANUP_PARITY_TOLERANCE_MM)
            .toBeCloseTo(25.4 / SCAN_CLEANUP_PARITY_CANVAS_DPI, 12);
    });

    it('normalizes pixels and points into the same physical answer', () => {
        const raster = rasterObservation();
        const lossless = losslessObservationAt(millimetresFromPixels(100, SCAN_CLEANUP_PARITY_CANVAS_DPI) / 25.4 * 72);
        expect(raster.contentRectMm.widthMm)
            .toBeCloseTo(millimetresFromPixels(600, SCAN_CLEANUP_PARITY_CANVAS_DPI), 9);
        expect(lossless.contentRectMm.widthMm).toBeCloseTo(raster.contentRectMm.widthMm, 9);
        expect(lossless.deliveredMarginsMm.topMm).toBeCloseTo(raster.deliveredMarginsMm.topMm, 9);
        expect(raster.canvasRectMm.widthMm).toBeCloseTo(millimetresFromPoints(LETTER_WIDTH_POINTS), 9);
        expect(raster.contentScaleOfCanvas.width)
            .toBeCloseTo(600 / CANVAS_WIDTH_PX, 9);
    });

    it('accepts a one-pixel disagreement and rejects a two-pixel one', () => {
        const onePixelPoints = 1 / SCAN_CLEANUP_PARITY_CANVAS_DPI * 72;
        const baseXPoints = 100 / SCAN_CLEANUP_PARITY_CANVAS_DPI * 72;
        const within = compareScanCleanupParityObservations([
            rasterObservation(),
            losslessObservationAt(baseXPoints + onePixelPoints),
        ]);
        expect(within.flatMap(comparison => comparison.deltas).filter(delta => !delta.withinTolerance))
            .toEqual([]);
        const beyond = compareScanCleanupParityObservations([
            rasterObservation(),
            losslessObservationAt(baseXPoints + (2 * onePixelPoints)),
        ]);
        const exceeded = beyond
            .flatMap(comparison => comparison.deltas)
            .filter(delta => !delta.withinTolerance)
            .map(delta => delta.field);
        expect(exceeded).toContain('placementOffsetMm.xMm');
        expect(exceeded).toContain('deliveredMarginsMm.leftMm');
    });

    it('reports the paths a comparison is missing instead of passing on two of three', () => {
        const [comparison] = compareScanCleanupParityObservations([rasterObservation()]);
        expect(comparison?.missingPaths).toEqual([
            'lossless-final',
            'preview',
        ]);
    });

    it('fails a typed warning disagreement between paths that publish events', () => {
        const preview: IScanCleanupParityObservation = {
            ...rasterObservation(),
            path: 'preview',
            warningEvents: [{code: 'matched-canvas-margins-reduced'}],
        };
        const deltas = compareScanCleanupParityObservations([
            rasterObservation(),
            preview,
        ]).flatMap(comparison => comparison.deltas);
        expect(deltas.find(delta => delta.field === 'warningEventSignatures')?.withinTolerance).toBe(false);
    });

    it('compares warning parameters only where they are not stated on a producer grid', () => {
        // Page numbers name the same document for every path, so they are part
        // of the signature; a pixel extent is the producing fitter's own grid,
        // which this corpus never compares against another grid's decimals.
        expect(scanCleanupParityWarningSignature({
            code: 'matched-canvas-content-fitted-pages',
            pages: [1],
        })).not.toBe(scanCleanupParityWarningSignature({
            code: 'matched-canvas-content-fitted-pages',
            pages: [2],
        }));
        expect(scanCleanupParityWarningSignature({
            code: 'matched-canvas-content-fitted',
            unit: 'px',
            contentWidth: 600,
            contentHeight: 800,
            innerWidth: 500,
            innerHeight: 700,
        })).toBe(scanCleanupParityWarningSignature({
            code: 'matched-canvas-content-fitted',
            unit: 'pt',
            contentWidth: 288,
            contentHeight: 384,
            innerWidth: 240,
            innerHeight: 336,
        }));
    });

    it('omits the warning comparison for a path with no typed channel', () => {
        const deltas = compareScanCleanupParityObservations([
            rasterObservation(),
            losslessObservationAt(100 / SCAN_CLEANUP_PARITY_CANVAS_DPI * 72),
        ]).flatMap(comparison => comparison.deltas);
        expect(deltas.some(delta => delta.field === 'warningEventSignatures')).toBe(false);
    });

    it('turns a page-space placement into the orientation the reader sees', () => {
        const canvas = {
            width: 400,
            height: 600,
        };
        // Ten points in from the left and twenty down from the top of the
        // unrotated page.
        const content = {
            x: 10,
            y: 600 - 20 - 100,
            width: 50,
            height: 100,
        };
        expect(presentScanCleanupParityPageSpaceRect(canvas, content, 0)).toEqual({
            canvasPoints: {
                widthPoints: 400,
                heightPoints: 600,
            },
            contentPoints: {
                xPoints: 10,
                yTopPoints: 20,
                widthPoints: 50,
                heightPoints: 100,
            },
        });
        // A quarter turn clockwise sends the top edge to the right edge, so the
        // twenty points below the top become twenty points inside the right.
        expect(presentScanCleanupParityPageSpaceRect(canvas, content, 90)).toEqual({
            canvasPoints: {
                widthPoints: 600,
                heightPoints: 400,
            },
            contentPoints: {
                xPoints: 600 - 20 - 100,
                yTopPoints: 10,
                widthPoints: 100,
                heightPoints: 50,
            },
        });
        expect(presentScanCleanupParityPageSpaceRect(canvas, content, 180)).toEqual({
            canvasPoints: {
                widthPoints: 400,
                heightPoints: 600,
            },
            contentPoints: {
                xPoints: 400 - 10 - 50,
                yTopPoints: 600 - 20 - 100,
                widthPoints: 50,
                heightPoints: 100,
            },
        });
        expect(presentScanCleanupParityPageSpaceRect(canvas, content, 270)).toEqual({
            canvasPoints: {
                widthPoints: 600,
                heightPoints: 400,
            },
            contentPoints: {
                xPoints: 20,
                yTopPoints: 400 - 10 - 50,
                widthPoints: 100,
                heightPoints: 50,
            },
        });
    });

    it('rejects a malformed report as loudly as an out-of-tolerance placement', () => {
        const report = corpusReport();
        expect(() => assertScanCleanupParityReport(JSON.parse(JSON.stringify(report)))).not.toThrow();

        expect(() => assertScanCleanupParityReport({
            ...report,
            fixtures: [
                {
                    ...report.fixtures[0]!,
                    sha256: 'not-a-digest',
                },
                ...report.fixtures.slice(1),
            ],
        })).toThrow(/SHA-256/u);
        expect(() => assertScanCleanupParityReport({
            ...report,
            tolerance: {
                ...report.tolerance,
                rasterCanvasPixels: 2,
            },
        })).toThrow(/one raster canvas pixel/u);
        expect(() => assertScanCleanupParityReport({
            ...report,
            tolerance: {
                ...report.tolerance,
                millimetres: report.tolerance.millimetres * 3,
            },
        })).toThrow(/declared pixel tolerance/u);
        expect(() => assertScanCleanupParityReport({
            ...report,
            cases: [
                {
                    ...report.cases[0]!,
                    observations: [],
                },
                ...report.cases.slice(1),
            ],
        })).toThrow(/observations must not be empty/u);
        expect(() => assertScanCleanupParityReport({
            ...report,
            pathSubstitutions: [{
                caseId: 'a-case-this-report-never-ran',
                path: 'lossless-final',
                reason: 'unrelated',
            }],
        })).toThrow(/names no case in this report/u);
    });

    it('ties every case to exactly one recorded fixture identity', () => {
        const report = corpusReport();
        // A digest that identifies no retained fixture, two fixtures that claim
        // one digest, and a digest that belongs to a different document than
        // the case names: each leaves a case whose bytes are unaccounted for.
        expect(() => assertScanCleanupParityReport({
            ...report,
            cases: [
                {
                    ...report.cases[0]!,
                    fixtureSha256: 'f'.repeat(64),
                },
                ...report.cases.slice(1),
            ],
        })).toThrow(/matches 0 fixture identities/u);
        expect(() => assertScanCleanupParityReport({
            ...report,
            fixtures: [
                report.fixtures[0]!,
                {
                    ...report.fixtures[1]!,
                    sha256: report.fixtures[0]!.sha256,
                },
                ...report.fixtures.slice(2),
            ],
        })).toThrow(/declares one digest for both/u);
        expect(() => assertScanCleanupParityReport({
            ...report,
            fixtures: [
                report.fixtures[0]!,
                {
                    ...report.fixtures[1]!,
                    fixture: report.fixtures[0]!.fixture,
                },
                ...report.fixtures.slice(2),
            ],
        })).toThrow(/twice/u);
        expect(() => assertScanCleanupParityReport({
            ...report,
            cases: [
                {
                    ...report.cases[0]!,
                    fixtureSha256: report.fixtures[report.fixtures.length - 1]!.sha256,
                },
                ...report.cases.slice(1),
            ],
        })).toThrow(/digest of a different fixture/u);
    });

    it('refuses a report whose cases leave a declared requirement uncovered', () => {
        // The builder is the first reader of its own evidence, so a corpus that
        // drops a case never produces a report to file.
        expect(() => corpusReport(
            SCAN_CLEANUP_PARITY_CASES.filter(entry => entry.id !== 'split-leaves'),
        )).toThrow(/split-leaves/u);
        const report = corpusReport();
        expect(report.coverage.gaps).toEqual([]);
        expect(report.coverage.covered).toEqual([...SCAN_CLEANUP_PARITY_REQUIREMENTS]);
        expect(() => assertScanCleanupParityReport({
            ...report,
            coverage: {
                ...report.coverage,
                covered: report.coverage.covered.slice(1),
            },
        })).toThrow(/coverage.covered/u);
        expect(() => assertScanCleanupParityReport({
            ...report,
            coverage: {
                ...report.coverage,
                requirements: report.coverage.requirements.slice(1),
            },
        })).toThrow(/requirements SC-IMP-004 declares/u);
    });

    it('makes a path that publishes no typed events state its blocker', () => {
        const report = corpusReport();
        expect(report.typedWarningChannelLimitations).toEqual([LOSSLESS_TYPED_WARNING_BLOCKER]);
        expect(() => assertScanCleanupParityReport({
            ...report,
            typedWarningChannelLimitations: [],
        })).toThrow(/published no typed warning events and declared no blocker/u);
        expect(() => assertScanCleanupParityReport({
            ...report,
            typedWarningChannelLimitations: [
                LOSSLESS_TYPED_WARNING_BLOCKER,
                {
                    path: 'raster-final',
                    reason: 'unfounded',
                },
            ],
        })).toThrow(/published typed warning events and cannot declare a blocker/u);
    });

    it('carries the case that declares a path substitution into the report', () => {
        const report = corpusReport();
        expect(report.cases
            .filter(entry => entry.expectedPathSubstitutions.length > 0)
            .map(entry => [
                entry.id,
                entry.expectedPathSubstitutions,
            ])).toEqual([[
            'paper-larger-than-canvas',
            ['lossless-final'],
        ]]);
    });

    it('identifies the report it was written beside, not only the inputs', () => {
        const evidence = identityEvidenceTree();
        try {
            const {
                identities,
                report,
                sources,
            } = evidence;
            expect(identities.report).toEqual({
                path: evidence.reportFile.path,
                sha256: evidence.reportFile.sha256,
                bytes: evidence.reportFile.bytes,
            });
            expect(identities.fixtures).toEqual(report.fixtures);
            expect(() => assertScanCleanupParityIdentities({
                ...identities,
                report: {
                    ...identities.report,
                    sha256: 'not-a-digest',
                },
            }, report, sources)).toThrow(/identities.report.sha256/u);
            expect(() => assertScanCleanupParityIdentities({
                ...identities,
                report: {
                    ...identities.report,
                    bytes: 0,
                },
            }, report, sources)).toThrow(/identities.report.bytes/u);
            expect(() => assertScanCleanupParityIdentities({
                ...identities,
                fixtures: identities.fixtures.slice(1),
            }, report, sources)).toThrow(/exactly the fixture identities/u);
            expect(() => assertScanCleanupParityIdentities({
                ...identities,
                engines: [
                    identities.engines[0]!,
                    identities.engines[0]!,
                ],
            }, report, sources)).toThrow(/twice/u);
        } finally {
            evidence.remove();
        }
    });

    it('rejects an identity the file it names no longer matches', () => {
        const evidence = identityEvidenceTree();
        try {
            const {
                identities,
                report,
                sources,
            } = evidence;
            // Same length, different bytes: a record checked against the
            // numbers it carries rather than against the file would pass this.
            writeFileSync(
                evidence.reportFile.path,
                readFileSync(evidence.reportFile.path, 'utf8').replace('"schemaVersion"', '"schemaVersioN"'),
                'utf8',
            );
            expect(() => assertScanCleanupParityIdentities(identities, report, sources))
                .toThrow(/identities\.report\.sha256 claims .* hashes to /u);
            writeFileSync(evidence.reportFile.path, 'truncated', 'utf8');
            expect(() => assertScanCleanupParityIdentities(identities, report, sources))
                .toThrow(/identities\.report\.bytes claims .* is 9 bytes/u);
        } finally {
            evidence.remove();
        }
    });

    it('rejects an engine or fixture whose bytes were replaced or removed', () => {
        const evidence = identityEvidenceTree();
        try {
            const {
                identities,
                report,
                sources,
            } = evidence;
            // Same length, different build: only a reader that hashes the
            // binary itself can tell these two apart.
            writeFileSync(evidence.engineFile.path, 'engine BYTES\n', 'utf8');
            expect(() => assertScanCleanupParityIdentities(identities, report, sources))
                .toThrow(/identities\.engines\[0\]\.sha256 claims .* hashes to /u);
            rmSync(evidence.engineFile.path);
            expect(() => assertScanCleanupParityIdentities(identities, report, sources))
                .toThrow(/identities\.engines\[0\] names a file that is not there/u);
        } finally {
            evidence.remove();
        }
    });

    it('rejects a fixture document that no longer hashes to its recorded identity', () => {
        const evidence = identityEvidenceTree();
        try {
            const {
                identities,
                report,
                sources,
            } = evidence;
            const fixturePath = join(sources.fixtureDir, identities.fixtures[0]!.fileName);
            // The whole record moves together, so the mismatch is between the
            // record and the document rather than between the two records.
            writeFileSync(
                fixturePath,
                readFileSync(fixturePath, 'utf8').replace('%PDF', '%pdf'),
                'utf8',
            );
            expect(() => assertScanCleanupParityIdentities(identities, report, sources))
                .toThrow(/identities\.fixtures\[0\]\.sha256 claims .* hashes to /u);
            rmSync(fixturePath);
            expect(() => assertScanCleanupParityIdentities(identities, report, sources))
                .toThrow(/identities\.fixtures\[0\] names a file that is not there/u);
        } finally {
            evidence.remove();
        }
    });
});

/**
 * One rectangle, stated as fractions of the page it was measured on: its left
 * edge a tenth of the way across, its right edge 35 hundredths, its top a tenth
 * of the way down and its bottom three tenths. Every expectation below places
 * those fractions by hand on a 400x600 pt page whose box starts at (36, 72):
 *
 *   across  x = 36 + 0.1 * 400 = 76,  width = 0.25 * 400 = 100
 *   down    the bottom edge is 0.3 of the way down, so it sits (1 - 0.3) * 600
 *           = 420 pt above the box's bottom: y = 72 + 420 = 492,
 *           height = 0.2 * 600 = 120
 *
 * A quarter turn only re-labels which fraction is which, so each rotated case
 * states the relabelling it applies rather than a second projection.
 */
const PROJECTION_PAGE_BOX = {
    xPoints: 36,
    yPoints: 72,
    widthPoints: 400,
    heightPoints: 600,
};

/** The measured rectangle on a portrait render: 200x300 px at those fractions. */
const PORTRAIT_ANALYSIS_RECT = {
    xPx: 20,
    yPx: 30,
    widthPx: 50,
    heightPx: 60,
};

/** The same fractions on a landscape render: 300x200 px. */
const LANDSCAPE_ANALYSIS_RECT = {
    xPx: 30,
    yPx: 20,
    widthPx: 75,
    heightPx: 40,
};

function expectPageSpaceRect(
    actual: IScanCleanupParityPageSpaceRect,
    expected: IScanCleanupParityPageSpaceRect,
) {
    for (const field of [
        'x',
        'y',
        'width',
        'height',
    ] as const) {
        expect(actual[field], field).toBeCloseTo(expected[field], 9);
    }
}

describe('scan cleanup parity analysis-rect projection', () => {
    it('places a measured rectangle on an unrotated page from the crop box out', () => {
        expectPageSpaceRect(
            mapScanCleanupParityAnalysisRectToPdfPoints(PORTRAIT_ANALYSIS_RECT, 200, 300, 0, {
                ...PROJECTION_PAGE_BOX,
                rotation: 0,
            }),
            {
                x: 76,
                y: 492,
                width: 100,
                height: 120,
            },
        );
        // The crop box's own origin moves the whole projection with it, so a
        // page that starts at zero lands 36 pt left and 72 pt below.
        expectPageSpaceRect(
            mapScanCleanupParityAnalysisRectToPdfPoints(PORTRAIT_ANALYSIS_RECT, 200, 300, 0, {
                xPoints: 0,
                yPoints: 0,
                widthPoints: 400,
                heightPoints: 600,
                rotation: 0,
            }),
            {
                x: 40,
                y: 420,
                width: 100,
                height: 120,
            },
        );
    });

    it('undoes a quarter turn the document asks a reader to apply', () => {
        // /Rotate 90 presents the page turned clockwise, so undoing it sends
        // the render's downward fractions across the page and its rightward
        // fractions up it: across 0.1..0.3, down 0.65..0.9.
        expectPageSpaceRect(
            mapScanCleanupParityAnalysisRectToPdfPoints(LANDSCAPE_ANALYSIS_RECT, 300, 200, 0, {
                ...PROJECTION_PAGE_BOX,
                rotation: 90,
            }),
            {
                // 36 + 0.1 * 400, and (1 - 0.9) * 600 above the box's bottom.
                x: 76,
                y: 132,
                width: 80,
                height: 150,
            },
        );
        // A half turn mirrors both axes: across 0.65..0.9, down 0.7..0.9.
        expectPageSpaceRect(
            mapScanCleanupParityAnalysisRectToPdfPoints(PORTRAIT_ANALYSIS_RECT, 200, 300, 0, {
                ...PROJECTION_PAGE_BOX,
                rotation: 180,
            }),
            {
                x: 296,
                y: 132,
                width: 100,
                height: 120,
            },
        );
        // /Rotate 270 is the other quarter turn: across 0.7..0.9, down 0.1..0.35.
        expectPageSpaceRect(
            mapScanCleanupParityAnalysisRectToPdfPoints(LANDSCAPE_ANALYSIS_RECT, 300, 200, 0, {
                ...PROJECTION_PAGE_BOX,
                rotation: 270,
            }),
            {
                x: 316,
                y: 462,
                width: 80,
                height: 150,
            },
        );
        // The two quarter turns are opposite turns of the same rectangle, so a
        // projection that confused their direction would place them alike.
        expect(mapScanCleanupParityAnalysisRectToPdfPoints(LANDSCAPE_ANALYSIS_RECT, 300, 200, 0, {
            ...PROJECTION_PAGE_BOX,
            rotation: 90,
        })).not.toEqual(mapScanCleanupParityAnalysisRectToPdfPoints(LANDSCAPE_ANALYSIS_RECT, 300, 200, 0, {
            ...PROJECTION_PAGE_BOX,
            rotation: 270,
        }));
    });

    it('undoes the quarter turn scan cleanup applied before measuring', () => {
        // Scan cleanup turned the render before analysing it, so the rectangle
        // was measured against 300x200 px while the page still renders 200x300.
        // Undoing that one turn reaches the same place a page rotation of 90
        // does, because both are one clockwise turn between the page and the
        // measurement.
        expectPageSpaceRect(
            mapScanCleanupParityAnalysisRectToPdfPoints(LANDSCAPE_ANALYSIS_RECT, 200, 300, 90, {
                ...PROJECTION_PAGE_BOX,
                rotation: 0,
            }),
            {
                x: 76,
                y: 132,
                width: 80,
                height: 150,
            },
        );
        // Both turns together are a half turn, and the rectangle was measured
        // against a portrait frame because the page renders landscape.
        expectPageSpaceRect(
            mapScanCleanupParityAnalysisRectToPdfPoints(PORTRAIT_ANALYSIS_RECT, 300, 200, 90, {
                ...PROJECTION_PAGE_BOX,
                rotation: 90,
            }),
            {
                x: 296,
                y: 132,
                width: 100,
                height: 120,
            },
        );
    });

    it('refuses a projection whose arithmetic leaves the range', () => {
        // Every input here is a measurement and the far edge of the rectangle
        // is not: x plus width leaves the range before it is ever divided by
        // the frame, and nothing downstream brings the width back.
        expect(() => mapScanCleanupParityAnalysisRectToPdfPoints({
            xPx: Number.MAX_VALUE,
            yPx: 30,
            widthPx: Number.MAX_VALUE,
            heightPx: 60,
        }, Number.MAX_VALUE, 300, 0, {
            ...PROJECTION_PAGE_BOX,
            rotation: 0,
        })).toThrow(/analysis rect projection width must be a finite number/u);
        // The overflow can also happen on the way back out: a sound tenth of a
        // page added to a crop box stated at the top of the range is not a
        // place on that page.
        expect(() => mapScanCleanupParityAnalysisRectToPdfPoints(PORTRAIT_ANALYSIS_RECT, 200, 300, 0, {
            xPoints: Number.MAX_VALUE,
            yPoints: 72,
            widthPoints: Number.MAX_VALUE,
            heightPoints: 600,
            rotation: 0,
        })).toThrow(/analysis rect projection x must be a finite number/u);
        // A rectangle measured off the render is a rectangle off the page, not
        // an overflow: the range check must leave its negative fractions alone.
        expect(() => mapScanCleanupParityAnalysisRectToPdfPoints({
            xPx: -40,
            yPx: -30,
            widthPx: 50,
            heightPx: 60,
        }, 200, 300, 0, {
            ...PROJECTION_PAGE_BOX,
            rotation: 0,
        })).not.toThrow();
    });

    it('refuses geometry no projection is defined for', () => {
        expect(() => mapScanCleanupParityAnalysisRectToPdfPoints(PORTRAIT_ANALYSIS_RECT, 0, 300, 0, {
            ...PROJECTION_PAGE_BOX,
            rotation: 0,
        })).toThrow(/displayWidthPx must be a positive finite number/u);
        expect(() => mapScanCleanupParityAnalysisRectToPdfPoints(PORTRAIT_ANALYSIS_RECT, 200, 300, 0, {
            ...PROJECTION_PAGE_BOX,
            widthPoints: Number.NaN,
            rotation: 0,
        })).toThrow(/page widthPoints must be a positive finite number/u);
        expect(() => mapScanCleanupParityAnalysisRectToPdfPoints(PORTRAIT_ANALYSIS_RECT, 200, 300, 45, {
            ...PROJECTION_PAGE_BOX,
            rotation: 0,
        })).toThrow(/cleanup rotation must be a quarter turn/u);
    });
});

describe('scan cleanup parity warning comparison policy', () => {
    it('records a decision for every warning code SC-IMP-003 declares', () => {
        expect(Object.keys(SCAN_CLEANUP_PARITY_WARNING_COMPARISON_POLICY).sort())
            .toEqual([...SCAN_CLEANUP_WARNING_EVENT_CODES].sort());
        // A code that reaches the comparison without a decision is a failure,
        // not a default: guessing either way would silently invent a
        // disagreement or drop a real one.
        const unclassified: unknown = {code: 'matched-canvas-nobody-classified-this'};
        expect(() => scanCleanupParityWarningSignature(unclassified as TScanCleanupWarningEvent))
            .toThrow(/no warning comparison policy/u);
    });

    it('compares a condition stated on the producer grid by its code alone', () => {
        // These pixel counts carry no unit field, so the shape says nothing
        // about which grid they are on; the code does.
        expect(scanCleanupParityWarningSignature({
            code: 'matched-canvas-intrinsic-overflow',
            leftPx: 4,
            rightPx: 6,
        })).toBe(scanCleanupParityWarningSignature({
            code: 'matched-canvas-intrinsic-overflow',
            leftPx: 9,
            rightPx: 1,
        }));
        expect(scanCleanupParityWarningSignature({
            code: 'matched-canvas-document-dpi-normalized',
            canvasDpi: 150,
            finestPageDpi: 150,
        })).toBe(scanCleanupParityWarningSignature({
            code: 'matched-canvas-document-dpi-normalized',
            canvasDpi: 300,
            finestPageDpi: 299.5,
        }));
    });

    it('keeps a document-level parameter compared on a shape that carries a unit', () => {
        // The page list of a resampling report means the same thing on every
        // path. A revision that starts stating the producer's unit beside it
        // must not take the page list out of the comparison with it, which is
        // exactly what deciding from the payload's shape used to do.
        const resampled = (pages: number[]) => {
            const payload: unknown = {
                code: 'matched-canvas-pages-resampled',
                pages,
                unit: 'px',
            };
            return payload as TScanCleanupWarningEvent;
        };
        expect(scanCleanupParityWarningSignature(resampled([1]))).toContain('"pages"');
        expect(scanCleanupParityWarningSignature(resampled([1])))
            .not.toBe(scanCleanupParityWarningSignature(resampled([2])));
    });
});

describe('scan cleanup parity warning attribution', () => {
    const captured = (
        event: TScanCleanupWarningEvent,
        formatted: string,
    ): IScanCleanupParityCapturedWarningEvent => ({
        event,
        formatted,
    });

    it('attributes a sentence to its event whatever order they were published in', () => {
        const capture = [
            captured({code: 'matched-canvas-margins-reduced'}, 'Margins were reduced.'),
            captured({code: 'matched-canvas-dropped'}, 'Matched page size was dropped.'),
        ];
        expect(attributeScanCleanupParityWarningEvents(capture, [
            'Matched page size was dropped.',
            'Margins were reduced.',
        ])).toEqual([
            {code: 'matched-canvas-dropped'},
            {code: 'matched-canvas-margins-reduced'},
        ]);
        expect(capture).toEqual([]);
    });

    it('consumes one captured event per identical sentence', () => {
        const capture = [
            captured({code: 'matched-canvas-margins-reduced'}, 'Margins were reduced.'),
            captured({code: 'matched-canvas-margins-reduced'}, 'Margins were reduced.'),
        ];
        expect(attributeScanCleanupParityWarningEvents(capture, [
            'Margins were reduced.',
            'Margins were reduced.',
        ])).toHaveLength(2);
        expect(capture).toEqual([]);
    });

    it('leaves an unattributed event in the capture and skips an unstructured sentence', () => {
        // A sentence no captured event formatted is a native diagnostic, which
        // carries no code by definition. An event no sentence claimed stays in
        // the capture, which is what the caller's per-page assertion catches.
        const capture = [captured({code: 'matched-canvas-dropped'}, 'Matched page size was dropped.')];
        expect(attributeScanCleanupParityWarningEvents(capture, ['Page 2: the scanner reported a short read.']))
            .toEqual([]);
        expect(capture).toHaveLength(1);
    });
});

describe('scan cleanup parity normalization', () => {
    const normalizingCanvasPixels = (
        metadata: Partial<IScanCleanupParityCanvasPixelSource['metadata']>,
    ) => () => normalizeScanCleanupParityCanvasPixelObservation(canvasPixelSource({metadata}));

    it('refuses a canvas whose two axes are not one grid', () => {
        // Letter at the corpus DPI is 1275x1650 px. One pixel of rounding on an
        // axis is the grid landing where it always does; a height taken at
        // twice the DPI is a second grid, and every millimetre below would be
        // derived from the width axis alone.
        expect(normalizingCanvasPixels({canvasHeightPx: CANVAS_HEIGHT_PX + 1})).not.toThrow();
        expect(normalizingCanvasPixels({canvasHeightPx: CANVAS_HEIGHT_PX * 2}))
            .toThrow(/DPI across and .* DPI down/u);
    });

    it('refuses pixel geometry it cannot convert into millimetres', () => {
        expect(normalizingCanvasPixels({canvasWidthPx: 0}))
            .toThrow(/canvasWidthPx must be a positive finite number/u);
        expect(normalizingCanvasPixels({matchedCanvasTargetWidthPoints: -612}))
            .toThrow(/matched canvas widthPoints must be a positive finite number/u);
        expect(normalizingCanvasPixels({
            matchedCanvasContentWidthPx: -1,
            outputWidthPx: -1,
        })).toThrow(/content widthPx must be a non-negative finite number/u);
        expect(normalizingCanvasPixels({placementOffsetYPx: Number.NaN}))
            .toThrow(/placementOffsetYPx must be a finite number/u);
    });

    it('refuses point geometry it cannot convert into millimetres', () => {
        const source = pointsSource();
        expect(() => normalizeScanCleanupParityPointsObservation({
            ...source,
            canvasPoints: {
                ...source.canvasPoints,
                heightPoints: 0,
            },
        })).toThrow(/canvas heightPoints must be a positive finite number/u);
        expect(() => normalizeScanCleanupParityPointsObservation({
            ...source,
            contentPoints: {
                ...source.contentPoints,
                widthPoints: Number.POSITIVE_INFINITY,
            },
        })).toThrow(/content widthPoints must be a non-negative finite number/u);
        // Paper this canvas cannot hold is a condition the corpus exercises, so
        // an offset outside the canvas is a measurement rather than a fault.
        expect(() => normalizeScanCleanupParityPointsObservation({
            ...source,
            contentPoints: {
                ...source.contentPoints,
                xPoints: -12,
            },
        })).not.toThrow();
        expect(() => normalizeScanCleanupParityPointsObservation({
            ...source,
            contentPoints: {
                ...source.contentPoints,
                yTopPoints: Number.NaN,
            },
        })).toThrow(/content yTopPoints must be a finite number/u);
    });

    it('refuses pixel geometry whose conversion leaves the range', () => {
        // Each source below states finite pixels against finite points. What
        // leaves the range is the arithmetic between them, which no check on
        // the inputs alone can see.
        expect(normalizingCanvasPixels({
            canvasWidthPx: Number.MAX_VALUE,
            matchedCanvasTargetWidthPoints: 1e-6,
        })).toThrow(/canvas DPI must be a positive finite number/u);
        // 8.5x11 px is Letter at one DPI, and a pixel count near the top of
        // the range is more millimetres than a double can state.
        expect(normalizingCanvasPixels({
            canvasWidthPx: 8.5,
            canvasHeightPx: 11,
            matchedCanvasContentWidthPx: Number.MAX_VALUE,
            outputWidthPx: Number.MAX_VALUE,
        })).toThrow(/content widthMm must be a non-negative finite number/u);
        // Half the range of paper with the content placed a quarter of the
        // range to the left of it: canvas, offset and content are each
        // measurements and the margin they leave is not.
        expect(normalizingCanvasPixels({
            canvasWidthPx: 1.5e308 / 72,
            canvasHeightPx: 1.5e308 / 72,
            matchedCanvasTargetWidthPoints: 1.5e308,
            matchedCanvasTargetHeightPoints: 1.5e308,
            placementOffsetXPx: -5e306,
        })).toThrow(/delivered rightMm must be a finite number/u);
        // A canvas that survives as a hair of paper is a canvas the corpus can
        // measure and cannot divide a page of content by.
        expect(normalizingCanvasPixels({
            canvasWidthPx: 1e-300,
            canvasHeightPx: 1e-300,
            matchedCanvasTargetWidthPoints: 1e-300,
            matchedCanvasTargetHeightPoints: 1e-300,
            matchedCanvasContentWidthPx: 1e10,
            outputWidthPx: 1e10,
        })).toThrow(/content width scale must be a finite number/u);
    });

    it('refuses point geometry whose conversion leaves the range', () => {
        const source = pointsSource();
        // A canvas 1e-300 pt across is thousands of pixels wide on a grid this
        // fine, so it passes every check the points path makes on its inputs.
        // The scale of a page of content on it is still not a number.
        expect(() => normalizeScanCleanupParityPointsObservation({
            ...source,
            canvasDpi: 1e306,
            canvasPoints: {
                widthPoints: 1e-300,
                heightPoints: 1e-300,
            },
            contentPoints: {
                ...source.contentPoints,
                widthPoints: 1e10,
            },
        })).toThrow(/content width scale must be a finite number/u);
    });

    it('holds the points path to a declared grid without sizing the paper by it', () => {
        const source = pointsSource();
        expect(() => normalizeScanCleanupParityPointsObservation({
            ...source,
            canvasDpi: 0,
        })).toThrow(/canvasDpi must be a positive finite number/u);
        expect(() => normalizeScanCleanupParityPointsObservation({
            ...source,
            canvasDpi: Number.POSITIVE_INFINITY,
        })).toThrow(/canvasDpi must be a positive finite number/u);
        // Letter at a hundredth of a DPI is under a tenth of a pixel across.
        // The points path never divides the geometry by the grid it declares, so
        // the canvas is as measurable here as it is at any other DPI, and the
        // grid travels into the report as the declaration it is.
        const subpixel = normalizeScanCleanupParityPointsObservation({
            ...source,
            canvasDpi: 0.01,
        });
        expect(subpixel.canvasDpi).toBe(0.01);
        expect(subpixel.canvasRectMm).toEqual(
            normalizeScanCleanupParityPointsObservation(source).canvasRectMm,
        );
    });
});
