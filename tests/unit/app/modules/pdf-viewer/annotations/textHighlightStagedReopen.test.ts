import { createHash } from 'node:crypto';
import {
    mkdtemp,
    readFile,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterAll,
    describe,
    expect,
    it,
} from 'vitest';
import type {
    AnnotationId,
    ITextMarkupEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { mintAnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import type { IAnnotationVerificationDiagnostic } from '@app/modules/pdf-viewer/serialization/serializationPlan';
import { createTemporaryDirectoryRegistry } from '@tests/helpers/createTemporaryDirectoryRegistry';
import type {
    IExistingHighlight,
    IFixtureOptions,
    ISelectionBox,
    IStageHighlightOptions,
} from '@tests/helpers/textHighlightStagedSaveHarness';
import {
    createHighlightFixturePdf,
    ingestFixtureAnnotations,
    mutateStagedHighlight,
    readPreexistingAnnotationIds,
    restorePdfjsCanvasGlobals,
    stageHighlightSave,
    toSelectionMarkerRects,
    withPdfjsDocument,
} from '@tests/helpers/textHighlightStagedSaveHarness';

const temporaryDirectories = createTemporaryDirectoryRegistry();

const PDFJS_CANVAS_GLOBAL_KEYS = [
    'DOMMatrix',
    'ImageData',
    'Path2D',
];

afterAll(async () => {
    restorePdfjsCanvasGlobals();
    await temporaryDirectories.cleanup();
});

const LINE_TOP = 0.11444805194805195;
const LINE_HEIGHT = 0.017676767676767676;

/**
 * One selected line as PDF.js measures it: a client rect per text-layer span.
 * The third fragment is 0.55 pt wide, which is what a selection that ends on a
 * narrow kerned run produces, and it is below the overlay's minimum marker size.
 */
const SUB_POINT_FRAGMENT_SELECTION: readonly ISelectionBox[] = [
    {
        x: 0.11764705882352941,
        y: LINE_TOP,
        width: 0.09321895424836601,
        height: LINE_HEIGHT,
    },
    {
        x: 0.21086601307189543,
        y: LINE_TOP,
        width: 0.13176470588235295,
        height: LINE_HEIGHT,
    },
    {
        x: 0.3426307189542484,
        y: LINE_TOP,
        width: 0.0009,
        height: LINE_HEIGHT,
    },
];

/** A selection whose last fragment runs past the right edge of the page box. */
const OVERHANGING_SELECTION: readonly ISelectionBox[] = [{
    x: 0.94,
    y: LINE_TOP,
    width: 0.08,
    height: LINE_HEIGHT,
}];

const PLAIN_SELECTION: readonly ISelectionBox[] = [
    {
        x: 0.11764705882352941,
        y: LINE_TOP,
        width: 0.09321895424836601,
        height: LINE_HEIGHT,
    },
    {
        x: 0.21086601307189543,
        y: LINE_TOP,
        width: 0.13176470588235295,
        height: LINE_HEIGHT,
    },
];

/**
 * A pre-existing incrementally saved Highlight, as the reported book carries:
 * one annotation whose `/QuadPoints` spans two selected lines.
 */
const MULTI_QUAD_HIGHLIGHT: IExistingHighlight = {quads: [
    [
        90,
        600,
        300,
        600,
        90,
        586,
        300,
        586,
    ],
    [
        90,
        584,
        260,
        584,
        90,
        570,
        260,
        570,
    ],
]};

/** A quad over the fixture's first drawn line, so page text overlaps it. */
const FIRST_LINE_QUAD = [
    72,
    711,
    300,
    711,
    72,
    698,
    300,
    698,
];

/**
 * How many stacked highlights one staged save fails on. Fifteen against a
 * twelve-entry record leaves a remainder of three, so an off-by-one in either
 * the cap or the remainder reads as a wrong number rather than a plausible one.
 */
const FAILED_MARKUP_COUNT = 15;

/**
 * The verifier's diagnostics ceiling, restated rather than imported. The
 * production constant is internal to the serialization plan, and a test that
 * read it would keep passing whatever the ceiling drifted to; this number is
 * the contract callers and logs depend on, so the test pins it directly.
 */
const DIAGNOSTIC_CAP = 12;

/** One single-line Highlight per stacked row, each on its own band of the page. */
const STACKED_HIGHLIGHTS: readonly IExistingHighlight[] = Array.from(
    {length: FAILED_MARKUP_COUNT},
    (_unused, index) => {
        const top = 700 - index * 30;
        const bottom = top - 14;
        return {quads: [[
            90,
            top,
            300,
            top,
            90,
            bottom,
            300,
            bottom,
        ]]};
    },
);

function createHighlightEntity(application: AnnotationApplication, boxes: readonly ISelectionBox[]) {
    const now = 1_700_000_000_000;
    return application.store.applyTextMarkupSelection({
        kind: 'text-markup',
        identity: {id: mintAnnotationId()},
        pageIndex: 0,
        subtype: 'Highlight',
        // Selection-created markup carries no note text; the selected document
        // text is derived for display and is never serialized as /Contents.
        text: '',
        geometry: toSelectionMarkerRects(boxes),
        color: 'rgba(255, 204, 0, 0.4)',
        opacity: 0.4,
        author: null,
        createdAt: now,
        modifiedAt: now,
        revision: 0,
        persistedRevision: -1,
        deleted: false,
    }, []).created;
}

async function runStagedSave(
    boxes: readonly ISelectionBox[],
    options: {
        fixture?: IFixtureOptions;
        staging?: Omit<IStageHighlightOptions, 'boxes'>;
    } = {},
) {
    const fixture = await createHighlightFixturePdf(options.fixture ?? {});
    const application = new AnnotationApplication('staged-reopen-fixture');
    const created = createHighlightEntity(application, boxes);
    const session = application.beginSave(null);
    const staged = await stageHighlightSave(fixture, {
        boxes,
        ...options.staging,
    });
    application.recordMaterializedIdentityBinding(session, created.identity.id, staged.pdfRef);
    return {
        application,
        annotationId: created.identity.id as AnnotationId,
        fixture,
        session,
        staged,
    };
}

/**
 * Opens a fixture the way the viewer does, restyles the markup the file already
 * carries, and stages the edit through a real writer round trip. The restyled
 * annotation is the one the save plan expects, so its geometry and its text
 * have to survive ingest, the edit and the reopen unchanged.
 */
async function runPreexistingMarkupEdit(fixture: Uint8Array) {
    const application = new AnnotationApplication('pre-existing-markup-fixture');
    await ingestFixtureAnnotations(application, fixture);
    const markup = application.store.list()
        .find((entity): entity is ITextMarkupEntity => entity.kind === 'text-markup');
    if (!markup) {
        throw new Error('The fixture ingested no text markup');
    }
    application.store.setStyle(markup.identity.id, {
        color: '#00ff00',
        opacity: 0.5,
    });
    const session = application.beginSave(null);
    const pdfRef = markup.identity.pdfRef ?? markup.identity.id;
    return {
        application,
        entity: markup,
        pdfRef,
        session,
        staged: await mutateStagedHighlight(fixture, pdfRef),
    };
}

/**
 * Ingests every stacked highlight, restyles all of them so the plan expects all
 * of them, and then moves every stored quad six points right. One save then
 * fails on more annotations than the verifier is allowed to describe, which is
 * the only way to see the bound and the exact total at the same time.
 */
async function runStackedMarkupEdit() {
    const fixture = await createHighlightFixturePdf({existingHighlights: STACKED_HIGHLIGHTS});
    const application = new AnnotationApplication('diagnostic-cap-fixture');
    await ingestFixtureAnnotations(application, fixture);
    const markups = application.store.list()
        .filter((entity): entity is ITextMarkupEntity => entity.kind === 'text-markup');
    if (markups.length !== FAILED_MARKUP_COUNT) {
        throw new Error(`The fixture ingested ${markups.length} markups, not ${FAILED_MARKUP_COUNT}`);
    }
    markups.forEach((markup) => {
        application.store.setStyle(markup.identity.id, {
            color: '#00ff00',
            opacity: 0.5,
        });
    });
    const session = application.beginSave(null);
    const pdfRefs = markups.map(markup => markup.identity.pdfRef ?? markup.identity.id);
    // A no-op pass is still a full writer round trip, which is the baseline the
    // moved bytes below are measured against.
    const roundTripped = await mutateStagedHighlight(fixture, pdfRefs[0]!);
    let moved = fixture;
    for (const pdfRef of pdfRefs) {
        // Sequential by necessity: each pass rewrites one annotation inside the
        // bytes the previous pass produced.
        moved = await mutateStagedHighlight(moved, pdfRef, (annotation) => {
            annotation.setQuadPoints(annotation.quadPoints().map((value, index) => (
                index % 2 === 0 ? value + 6 : value
            )));
        });
    }
    return {
        annotationIds: session.plan.expected.map(expected => expected.identity.id),
        application,
        moved,
        roundTripped,
        session,
    };
}

/**
 * Reads the failure the way a caller on any revision can: message, total
 * failure count, and whatever structured diagnostics the verifier attached.
 * Keeping the read duck-typed lets this file fail on its assertions rather
 * than on a missing export.
 */
async function captureVerificationFailure(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        if (error instanceof Error) {
            const diagnostics = Reflect.get(error, 'diagnostics');
            const failureCount = Reflect.get(error, 'failureCount');
            return {
                message: error.message,
                failureCount: typeof failureCount === 'number' ? failureCount : null,
                diagnostics: Array.isArray(diagnostics)
                    ? diagnostics as readonly IAnnotationVerificationDiagnostic[]
                    : [],
            };
        }
        throw error;
    }
    throw new Error('The staged bytes verified, but the test required a rejection');
}

describe('text highlight staged reopen verification', () => {
    it('verifies a selection whose fragments are narrower than the overlay minimum', async () => {
        const run = await runStagedSave(SUB_POINT_FRAGMENT_SELECTION);

        expect(run.staged.quadCount).toBe(SUB_POINT_FRAGMENT_SELECTION.length);
        await expect(run.application.verifySaveBytes(run.session, run.staged.bytes)).resolves.toBeUndefined();
    }, 60_000);

    it('verifies a selection that reaches past the page box', async () => {
        const run = await runStagedSave(OVERHANGING_SELECTION);

        await expect(run.application.verifySaveBytes(run.session, run.staged.bytes)).resolves.toBeUndefined();
    }, 60_000);

    it('verifies alongside pre-existing incrementally saved highlights', async () => {
        const run = await runStagedSave(PLAIN_SELECTION, {fixture: {existingHighlights: [MULTI_QUAD_HIGHLIGHT]}});

        await expect(run.application.verifySaveBytes(run.session, run.staged.bytes)).resolves.toBeUndefined();
    }, 60_000);

    it('accepts quad corner order and quad order the format leaves free', async () => {
        const run = await runStagedSave(PLAIN_SELECTION, {staging: {
            cornerOrder: 'spec-reversed',
            reverseQuadOrder: true,
        }});

        await expect(run.application.verifySaveBytes(run.session, run.staged.bytes)).resolves.toBeUndefined();
    }, 60_000);

    it('does not write the selected document text into /Contents', async () => {
        const run = await runStagedSave(PLAIN_SELECTION);

        expect(run.staged.contents).toBe('');
    }, 60_000);

    it('rejects a moved rectangle and names the rectangle and the delta', async () => {
        const run = await runStagedSave(PLAIN_SELECTION);
        const moved = await mutateStagedHighlight(run.staged.bytes, run.staged.pdfRef, (annotation) => {
            const values = annotation.quadPoints();
            // Shift the second quad 6 pt right: a move a reader can see.
            annotation.setQuadPoints(values.map((value, index) => (
                index >= 8 && index % 2 === 0 ? value + 6 : value
            )));
        });

        const error = await captureVerificationFailure(run.application.verifySaveBytes(run.session, moved));

        expect(error.message).toContain('markup geometry mismatch');
        expect(error.message).toContain('rect 1');
        expect(error.message).not.toContain('markup geometry count mismatch');
        const [diagnostic] = error.diagnostics;
        expect(diagnostic?.failedFields).toEqual(['geometry']);
        expect(diagnostic?.maxCoordinateDelta).toBeGreaterThan(0.009);
        expect(diagnostic?.worstRectIndex).toBe(1);
    }, 60_000);

    it('rejects a dropped rectangle and names the counts', async () => {
        const run = await runStagedSave(PLAIN_SELECTION);
        const truncated = await mutateStagedHighlight(run.staged.bytes, run.staged.pdfRef, (annotation) => {
            annotation.setQuadPoints(annotation.quadPoints().slice(0, 8));
        });

        const error = await captureVerificationFailure(run.application.verifySaveBytes(run.session, truncated));

        expect(error.message).toContain('markup geometry count mismatch (expected 2, reopened 1)');
        expect(error.diagnostics[0]?.failedFields).toEqual(['geometryCount']);
    }, 60_000);

    it('rejects a rewritten subtype and names both subtypes', async () => {
        const run = await runStagedSave(PLAIN_SELECTION);
        const rewritten = await mutateStagedHighlight(run.staged.bytes, run.staged.pdfRef, (annotation) => {
            annotation.setSubtype('Underline');
        });

        const error = await captureVerificationFailure(run.application.verifySaveBytes(run.session, rewritten));

        expect(error.message).toContain('markup subtype mismatch (expected Highlight, reopened Underline)');
        expect(error.diagnostics[0]?.failedFields).toEqual(['subtype']);
        expect(error.diagnostics[0]?.reopenedSubtype).toBe('Underline');
    }, 60_000);

    it('reports unexpected text without repeating it', async () => {
        const secret = 'It came to pass just as they had said.';
        const run = await runStagedSave(PLAIN_SELECTION);
        const withContents = await mutateStagedHighlight(run.staged.bytes, run.staged.pdfRef, (annotation) => {
            annotation.setContents(secret);
        });

        const error = await captureVerificationFailure(run.application.verifySaveBytes(run.session, withContents));

        expect(error.message).toContain('markup text mismatch (expected empty, reopened 38 chars)');
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error.diagnostics)).not.toContain(secret);
        const [diagnostic] = error.diagnostics;
        expect(diagnostic?.expectedText).toEqual({
            present: false,
            length: 0,
            hash: expect.any(String),
        });
        expect(diagnostic?.reopenedText.present).toBe(true);
        expect(diagnostic?.reopenedText.length).toBe(secret.length);
    }, 60_000);

    it('bounds the diagnostics while the failure count and the named sample stay exact', async () => {
        const run = await runStackedMarkupEdit();

        expect(run.annotationIds).toHaveLength(FAILED_MARKUP_COUNT);
        // Nothing moved in this one, so the failures below are the moves and
        // not a fixture that cannot survive a save at all.
        await expect(run.application.verifySaveBytes(run.session, run.roundTripped))
            .resolves.toBeUndefined();

        const error = await captureVerificationFailure(
            run.application.verifySaveBytes(run.session, run.moved),
        );

        // The count is the true scale of the failure, not the size of the sample.
        expect(error.failureCount).toBe(FAILED_MARKUP_COUNT);
        expect(error.diagnostics).toHaveLength(DIAGNOSTIC_CAP);
        expect(error.diagnostics.map(diagnostic => diagnostic.annotationId))
            .toEqual(run.annotationIds.slice(0, DIAGNOSTIC_CAP));
        expect(error.diagnostics.map(diagnostic => diagnostic.failedFields))
            .toEqual(Array.from({length: DIAGNOSTIC_CAP}, () => ['geometry']));
        const clauses = error.message
            .replace('Annotation reopen verification failed: ', '')
            .split('; ');
        expect(clauses).toHaveLength(DIAGNOSTIC_CAP + 1);
        expect(clauses.slice(0, DIAGNOSTIC_CAP).map(clause => clause.split(':')[0]))
            .toEqual(run.annotationIds.slice(0, DIAGNOSTIC_CAP));
        expect(clauses.at(-1)).toBe(`and ${FAILED_MARKUP_COUNT - DIAGNOSTIC_CAP} more`);
        run.annotationIds.slice(DIAGNOSTIC_CAP).forEach((annotationId) => {
            expect(error.message).not.toContain(annotationId);
        });
    }, 60_000);

    it('leaves the original untouched, keeps the highlight dirty, and verifies on retry', async () => {
        const directory = temporaryDirectories.register(await mkdtemp(join(tmpdir(), 'evb-107-')));
        const originalPath = join(directory, 'original.pdf');
        const run = await runStagedSave(PLAIN_SELECTION);
        await writeFile(originalPath, run.fixture);
        const originalDigest = createHash('sha256').update(await readFile(originalPath)).digest('hex');
        const moved = await mutateStagedHighlight(run.staged.bytes, run.staged.pdfRef, (annotation) => {
            annotation.setQuadPoints(annotation.quadPoints().map((value, index) => (
                index % 2 === 0 ? value + 6 : value
            )));
        });

        await captureVerificationFailure(run.application.verifySaveBytes(run.session, moved));

        expect(createHash('sha256').update(await readFile(originalPath)).digest('hex')).toBe(originalDigest);
        expect(run.application.rollbackSave(run.session)).toBe(true);
        const retryFrontier = run.application.store.beginSave(null);
        expect(run.application.store.dirtyAt(retryFrontier).map(entity => entity.identity.id))
            .toContain(run.annotationId);

        const retrySession = run.application.beginSave(null);
        const retryStaged = await stageHighlightSave(run.fixture, {boxes: PLAIN_SELECTION});
        run.application.recordMaterializedIdentityBinding(
            retrySession,
            run.annotationId,
            retryStaged.pdfRef,
        );
        await expect(run.application.verifySaveBytes(retrySession, retryStaged.bytes))
            .resolves.toBeUndefined();
        run.application.acknowledgeSave(retrySession);

        expect(run.application.store.dirtyAt(run.application.store.beginSave(null))).toEqual([]);
        expect(createHash('sha256').update(await readFile(originalPath)).digest('hex')).toBe(originalDigest);
    }, 90_000);

    it('verifies an edited pre-existing markup whose quads span several lines', async () => {
        const fixture = await createHighlightFixturePdf({existingHighlights: [MULTI_QUAD_HIGHLIGHT]});
        const run = await runPreexistingMarkupEdit(fixture);

        expect(run.entity.geometry).toHaveLength(2);
        expect(run.session.plan.expected.map(entity => entity.identity.id)).toEqual([run.entity.identity.id]);
        await expect(run.application.verifySaveBytes(run.session, run.staged)).resolves.toBeUndefined();
    }, 60_000);

    it('rejects a moved line of an edited pre-existing multi-quad markup', async () => {
        const fixture = await createHighlightFixturePdf({existingHighlights: [MULTI_QUAD_HIGHLIGHT]});
        const run = await runPreexistingMarkupEdit(fixture);
        const moved = await mutateStagedHighlight(fixture, run.pdfRef, (annotation) => {
            annotation.setQuadPoints(annotation.quadPoints().map((value, index) => (
                index >= 8 && index % 2 === 0 ? value + 6 : value
            )));
        });

        const error = await captureVerificationFailure(run.application.verifySaveBytes(run.session, moved));

        expect(error.message).toContain('markup geometry mismatch');
        expect(error.diagnostics[0]?.expectedGeometryCount).toBe(2);
        expect(error.diagnostics[0]?.maxCoordinateDelta).toBeGreaterThan(0.009);
    }, 60_000);

    it('verifies an edited pre-existing markup on a /Rotate 90 page', async () => {
        const fixture = await createHighlightFixturePdf({
            rotate: 90,
            existingHighlights: [MULTI_QUAD_HIGHLIGHT],
        });
        const run = await runPreexistingMarkupEdit(fixture);

        expect(run.entity.geometry).toHaveLength(2);
        await expect(run.application.verifySaveBytes(run.session, run.staged)).resolves.toBeUndefined();
    }, 60_000);

    it('verifies an edited pre-existing markup on a /Rotate 270 page', async () => {
        const fixture = await createHighlightFixturePdf({
            rotate: 270,
            existingHighlights: [MULTI_QUAD_HIGHLIGHT],
        });
        const run = await runPreexistingMarkupEdit(fixture);

        await expect(run.application.verifySaveBytes(run.session, run.staged)).resolves.toBeUndefined();
    }, 60_000);

    it('rejects a moved line on a rotated page, so rotation is mapped and not ignored', async () => {
        const fixture = await createHighlightFixturePdf({
            rotate: 90,
            existingHighlights: [MULTI_QUAD_HIGHLIGHT],
        });
        const run = await runPreexistingMarkupEdit(fixture);
        const moved = await mutateStagedHighlight(fixture, run.pdfRef, (annotation) => {
            annotation.setQuadPoints(annotation.quadPoints().map((value, index) => (
                index >= 8 && index % 2 === 1 ? value + 6 : value
            )));
        });

        const error = await captureVerificationFailure(run.application.verifySaveBytes(run.session, moved));

        expect(error.message).toContain('markup geometry mismatch');
    }, 60_000);

    it('verifies an edited pre-existing markup whose note lives in its linked popup', async () => {
        const fixture = await createHighlightFixturePdf({existingHighlights: [{
            ...MULTI_QUAD_HIGHLIGHT,
            popupNoteText: 'Checked against the Cairo edition.',
        }]});
        const run = await runPreexistingMarkupEdit(fixture);

        // The markup's own /Contents is empty; the note reaches the store
        // through the popup, so the reopen has to resolve it the same way.
        expect(run.entity.text).toBe('Checked against the Cairo edition.');
        await expect(run.application.verifySaveBytes(run.session, run.staged)).resolves.toBeUndefined();
    }, 60_000);

    it('rejects a rewritten note on a popup-linked markup without logging the note', async () => {
        const note = 'Checked against the Cairo edition.';
        const fixture = await createHighlightFixturePdf({existingHighlights: [{
            ...MULTI_QUAD_HIGHLIGHT,
            popupNoteText: note,
        }]});
        const run = await runPreexistingMarkupEdit(fixture);
        const rewritten = await mutateStagedHighlight(fixture, run.pdfRef, (annotation) => {
            annotation.setContents('Replaced by an unrelated note.');
        });

        const error = await captureVerificationFailure(run.application.verifySaveBytes(run.session, rewritten));

        expect(error.message).toContain('markup text mismatch');
        expect(error.message).not.toContain(note);
        expect(JSON.stringify(error.diagnostics)).not.toContain(note);
    }, 60_000);

    it('verifies an edited pre-existing markup whose stored quad is sub-point wide', async () => {
        // The stored quad is 0.55 pt wide, below the overlay's minimum marker
        // size. Ingest widens it and the file still holds the raw quad, so the
        // canonical boundary has to widen both sides identically.
        const fixture = await createHighlightFixturePdf({existingHighlights: [{quads: [[
            200,
            614,
            200.55,
            614,
            200,
            600,
            200.55,
            600,
        ]]}]});
        const run = await runPreexistingMarkupEdit(fixture);

        await expect(run.application.verifySaveBytes(run.session, run.staged)).resolves.toBeUndefined();
    }, 60_000);

    it('verifies an edited pre-existing markup whose /Contents only repeats the words under it', async () => {
        const fixture = await createHighlightFixturePdf({existingHighlights: [{
            quads: [FIRST_LINE_QUAD],
            contents: 'The quick brown fox jumps',
        }]});
        const run = await runPreexistingMarkupEdit(fixture);

        // Ingest treats /Contents that merely repeats the highlighted words as
        // derived preview text rather than a note, so the reopen has to reach
        // the same verdict instead of reporting text the save never dropped.
        expect(run.entity.text).toBe('');
        await expect(run.application.verifySaveBytes(run.session, run.staged)).resolves.toBeUndefined();
    }, 60_000);

    it('destroys the loaded document when the work inside it throws', async () => {
        const fixture = await createHighlightFixturePdf();
        const loadingTasks: Array<{destroyed: boolean}> = [];

        await expect(withPdfjsDocument(fixture, async (document) => {
            loadingTasks.push(document.loadingTask);
            throw new Error('staged save failed');
        })).rejects.toThrow('staged save failed');

        // A leaked document keeps a PDF.js worker and its transport alive for
        // the rest of the run, so one failing save must not cost a worker.
        expect(loadingTasks).toHaveLength(1);
        expect(loadingTasks[0]?.destroyed).toBe(true);
    }, 60_000);

    it('leaves the canvas globals as it found them once restored', async () => {
        // Earlier cases in this file have already loaded documents, so the
        // scope this case must see restored is the one before any install.
        restorePdfjsCanvasGlobals();
        const before = PDFJS_CANVAS_GLOBAL_KEYS.map(key => ({
            key,
            present: Object.hasOwn(globalThis, key),
            value: Reflect.get(globalThis, key),
        }));
        const fixture = await createHighlightFixturePdf();
        await withPdfjsDocument(fixture, async () => undefined);
        const installed = PDFJS_CANVAS_GLOBAL_KEYS.map(key => Reflect.get(globalThis, key));
        expect(PDFJS_CANVAS_GLOBAL_KEYS.every(key => Object.hasOwn(globalThis, key))).toBe(true);
        // The load really does overwrite the scope, so the restore below is
        // undoing something rather than confirming nothing happened.
        expect(installed).not.toEqual(before.map(entry => entry.value));

        restorePdfjsCanvasGlobals();

        before.forEach((entry) => {
            expect(Object.hasOwn(globalThis, entry.key)).toBe(entry.present);
            expect(Reflect.get(globalThis, entry.key)).toBe(entry.present ? entry.value : undefined);
        });
    }, 60_000);

    it('binds the staged annotation by its materialized ref', async () => {
        const fixture = await createHighlightFixturePdf({existingHighlights: [MULTI_QUAD_HIGHLIGHT]});
        const before = await readPreexistingAnnotationIds(fixture);
        const staged = await stageHighlightSave(fixture, {boxes: PLAIN_SELECTION});

        expect(before.has(staged.pdfRef)).toBe(false);
    }, 60_000);
});
