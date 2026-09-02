import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    constants,
    copyFileSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {execFile} from 'node:child_process';
import {
    dirname,
    join,
} from 'node:path';
import {promisify} from 'node:util';
import type {
    IPdfAnnotationIndexEntry,
    IPdfEmbeddedShapeIndexEntry,
    IPdfNativeMutationSet,
} from '@contracts/electronApiDocuments';
import {normalizePdfNativeMutationSet} from '@contracts/nativePdfMutations';
import {
    resolveLargePdfFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaVisibleToolbarWithDeadline,
    scrollViewerToPage,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {workspaceCrashCheckpointPath} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {
    readExactPdfFixtureIdentity,
    resolveExactPdfFixtureExpectation,
    validateExactPdfFixtureIdentity,
} from '@scripts/ci/stageExactPdfFixture';
import type {Page} from 'puppeteer-core';

const MATRIX_TIMEOUT_MS = 15 * 60_000;
// qpdf validates the 722 MB fixture in roughly 25 seconds per pass. Leave
// enough room for the native append and its post-save validation as well.
const PLACED_IMAGE_SAVE_TIMEOUT_MS = 120_000;
const ANNOTATION_INDEX_CHUNK_BYTES = 512 * 1_024;
const MODIFIED_AT = 'D:20260830020000Z';
const MATRIX_PAGE_INDEX = 24;
const PLACED_IMAGE_PAGE_NUMBER = 31;
const ACTIVE_IMAGE_PLACEMENT_SELECTOR = '.editor-pane.is-active .workspace-host[data-workspace-active="true"] .pdf-image-placement';
const fixture = resolveLargePdfFixtureAvailability();
const exactFixtureExpectation = resolveExactPdfFixtureExpectation();
const largePdfDescribe = selectFixtureDescribe(describe, fixture);
const execFileAsync = promisify(execFile);
const PLACED_IMAGE_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAoAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Al7UCSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//Z',
    'base64',
);

function toPdfUtf16BeHex(value: string) {
    const bytes = [
        0xfe,
        0xff,
    ];
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) {
            continue;
        }
        if (codePoint <= 0xffff) {
            bytes.push(codePoint >> 8, codePoint & 0xff);
            continue;
        }
        const adjusted = codePoint - 0x10000;
        const high = 0xd800 + (adjusted >> 10);
        const low = 0xdc00 + (adjusted & 0x3ff);
        bytes.push(high >> 8, high & 0xff, low >> 8, low & 0xff);
    }
    return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function qpdfObjectContainsText(value: string, text: string) {
    return value.includes(text) || value.toLowerCase().includes(toPdfUtf16BeHex(text));
}

interface INativeIdentityBinding {
    annotationId: string;
    pdfRef: string;
}

interface IAnnotationRef {
    generationNumber: number;
    objectNumber: number;
}

interface IMatrixRefs {
    freeTextEditor: IAnnotationRef;
    freeTextNote: IAnnotationRef;
    markup: Record<string, IAnnotationRef>;
    shapes: Record<string, IAnnotationRef>;
}

const matrixStableKeys = {
    freeTextEditor: 'issue-125-free-text-editor',
    freeTextNote: 'issue-125-free-text-note',
    markups: {
        Highlight: 'issue-125-markup-highlight',
        Squiggly: 'issue-125-markup-squiggly',
        StrikeOut: 'issue-125-markup-strikeout',
        Underline: 'issue-125-markup-underline',
    },
    shapes: {
        Circle: 'evb-shape:issue-125-circle',
        Ink: 'evb-shape:issue-125-ink',
        Line: 'evb-shape:issue-125-line',
        PolyLine: 'evb-shape:issue-125-polyline',
        Polygon: 'evb-shape:issue-125-polygon',
        Square: 'evb-shape:issue-125-square',
    },
} as const;

function copyExactFixture(sourcePath: string) {
    const artifactDirectory = mkdtempSync(join(dirname(sourcePath), '.evb-issue-125-matrix-'));
    const targetPath = join(artifactDirectory, 'native-annotation-matrix.pdf');
    try {
        copyFileSync(sourcePath, targetPath, constants.COPYFILE_FICLONE);
    } catch {
        copyFileSync(sourcePath, targetPath);
    }
    onTestFinished(() => rmSync(artifactDirectory, {
        force: true,
        recursive: true,
    }));
    return realpathSync(targetPath);
}

async function waitForCrashCheckpoint(sessionName: string, expectedPath: string) {
    const expectedRealPath = realpathSync(expectedPath);
    await expect.poll(() => {
        const checkpointPath = workspaceCrashCheckpointPath(sessionName);
        if (!existsSync(checkpointPath)) {
            return null;
        }
        const stored = JSON.parse(String(readFileSync(checkpointPath))) as {checkpoint?: {tabs?: Array<{sourceRef?: string | null;}>;};};
        return stored.checkpoint?.tabs?.some(tab => (
            typeof tab.sourceRef === 'string'
            && realpathSync(tab.sourceRef) === expectedRealPath
        )) ?? false;
    }, {timeout: 60_000}).toBe(true);
}

async function readWorkingCopyPath(page: Page) {
    const state = await readWorkspaceStateValues<{
        originalPath?: string | null;
        workingCopyPath?: string | null;
    }>(page, [
        'originalPath',
        'workingCopyPath',
    ]);
    if (typeof state.workingCopyPath !== 'string') {
        throw new Error(`Native annotation matrix has no working copy: ${JSON.stringify(state)}`);
    }
    return state.workingCopyPath;
}

async function applyOneLogicalNativeRevision(
    page: Page,
    workingCopyPath: string,
    mutations: IPdfNativeMutationSet,
) {
    return page.evaluate(async (input: {
        modifiedAt: string;
        mutations: IPdfNativeMutationSet;
        workingCopyPath: string;
    }) => {
        const files = window.electronAPI?.documentFiles;
        if (
            !files?.applyPdfNativeMutationsToWorkingCopy
            || !files.commitStagedPdfNativeMutations
        ) {
            throw new Error('Native staged mutation APIs are unavailable');
        }
        const before = await files.getDocumentRevision(input.workingCopyPath);
        const staged = await files.applyPdfNativeMutationsToWorkingCopy(
            input.workingCopyPath,
            input.mutations,
            input.modifiedAt,
            {expectedDocumentRevisionToken: before.token},
        );
        if (!staged.applied || !staged.stagedOutput || !staged.nativeMutationPostconditionsVerified) {
            throw new Error(`Native mutation did not stage: ${JSON.stringify(staged)}`);
        }
        const afterStage = await files.getDocumentRevision(input.workingCopyPath);
        const committed = await files.commitStagedPdfNativeMutations(
            input.workingCopyPath,
            staged.stagedOutput,
            {
                expectedDocumentRevisionToken: before.token,
                ...(staged.identityBindings?.length
                    ? {identityBindings: staged.identityBindings}
                    : {}),
            },
        );
        if (!committed.applied) {
            throw new Error(`Native mutation did not commit: ${JSON.stringify(committed)}`);
        }
        const afterCommit = await files.getDocumentRevision(input.workingCopyPath);
        return {
            afterCommitToken: afterCommit.token,
            afterStageToken: afterStage.token,
            beforeToken: before.token,
            identityBindings: staged.identityBindings ?? [],
        };
    }, {
        modifiedAt: MODIFIED_AT,
        mutations,
        workingCopyPath,
    });
}

async function readAnnotationIndex(page: Page, documentPath: string) {
    return page.evaluate(async (input: {
        chunkBytes: number;
        documentPath: string;
    }) => {
        const files = window.electronAPI?.documentFiles;
        if (
            !files?.beginPdfAnnotationIndex
            || !files.readPdfAnnotationIndexChunk
            || !files.releasePdfAnnotationIndex
        ) {
            throw new Error('PDF annotation index APIs are unavailable');
        }
        const revision = await files.getDocumentRevision(input.documentPath);
        const session = await files.beginPdfAnnotationIndex(
            input.documentPath,
            {expectedDocumentRevisionToken: revision.token},
        );
        const entries: IPdfAnnotationIndexEntry[] = [];
        let offset = 0;
        let released = false;
        try {
            while (true) {
                const chunk = await files.readPdfAnnotationIndexChunk(
                    session.sessionId,
                    offset,
                    {chunkBytes: input.chunkBytes},
                );
                entries.push(...chunk.entries);
                if (chunk.done) {
                    break;
                }
                if (chunk.nextOffset === null || chunk.nextOffset <= offset) {
                    throw new Error('Annotation index offset did not advance');
                }
                offset = chunk.nextOffset;
            }
        } finally {
            released = await files.releasePdfAnnotationIndex(session.sessionId);
        }
        if (!released) {
            throw new Error('Annotation index session was not released');
        }
        return {
            entries,
            revisionToken: revision.token,
        };
    }, {
        chunkBytes: ANNOTATION_INDEX_CHUNK_BYTES,
        documentPath,
    });
}

async function readShapeIndex(page: Page, documentPath: string) {
    return page.evaluate(async (input: {
        chunkBytes: number;
        documentPath: string;
    }) => {
        const files = window.electronAPI?.documentFiles;
        if (
            !files?.beginPdfEmbeddedShapeIndex
            || !files.readPdfEmbeddedShapeIndexChunk
            || !files.releasePdfEmbeddedShapeIndex
        ) {
            throw new Error('PDF embedded-shape index APIs are unavailable');
        }
        const revision = await files.getDocumentRevision(input.documentPath);
        const session = await files.beginPdfEmbeddedShapeIndex(
            input.documentPath,
            {expectedDocumentRevisionToken: revision.token},
        );
        const entries: IPdfEmbeddedShapeIndexEntry[] = [];
        let offset = 0;
        let released = false;
        try {
            while (true) {
                const chunk = await files.readPdfEmbeddedShapeIndexChunk(
                    session.sessionId,
                    offset,
                    {chunkBytes: input.chunkBytes},
                );
                entries.push(...chunk.entries);
                if (chunk.done) {
                    break;
                }
                if (chunk.nextOffset === null || chunk.nextOffset <= offset) {
                    throw new Error('Embedded-shape index offset did not advance');
                }
                offset = chunk.nextOffset;
            }
        } finally {
            released = await files.releasePdfEmbeddedShapeIndex(session.sessionId);
        }
        if (!released) {
            throw new Error('Embedded-shape index session was not released');
        }
        return entries;
    }, {
        chunkBytes: ANNOTATION_INDEX_CHUNK_BYTES,
        documentPath,
    });
}

function toRef(entry: IAnnotationRef): IAnnotationRef {
    return {
        generationNumber: entry.generationNumber,
        objectNumber: entry.objectNumber,
    };
}

async function readObject(documentPath: string, ref: IAnnotationRef) {
    const {stdout} = await execFileAsync('qpdf', [
        `--show-object=${ref.objectNumber},${ref.generationNumber}`,
        '--raw-stream-data',
        documentPath,
    ], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
    });
    return stdout;
}

async function readObjectDictionary(documentPath: string, ref: IAnnotationRef) {
    const {stdout} = await execFileAsync('qpdf', [
        `--show-object=${ref.objectNumber},${ref.generationNumber}`,
        documentPath,
    ], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
    });
    return stdout;
}

function requireNamedEntry(
    entries: IPdfAnnotationIndexEntry[],
    name: string,
    subtype: string,
) {
    const matches = entries.filter(entry => (
        entry.pageIndex === MATRIX_PAGE_INDEX
        && entry.name === name
        && entry.subtype === subtype
    ));
    expect(matches, `${subtype} ${name}`).toHaveLength(1);
    return matches[0]!;
}

function requireMarkupRefs(bindings: INativeIdentityBinding[]) {
    const refs: Record<string, IAnnotationRef> = {};
    for (const [
        subtype,
        appAnnotationId,
    ] of Object.entries(matrixStableKeys.markups)) {
        const binding = bindings.find(item => item.annotationId === appAnnotationId);
        expect(binding, `missing ${subtype} identity binding`).toBeTruthy();
        const match = /^(\d+) (\d+) R$/u.exec(binding!.pdfRef);
        if (!match) {
            throw new Error(`Invalid native identity binding: ${binding!.pdfRef}`);
        }
        refs[subtype] = {
            objectNumber: Number(match[1]),
            generationNumber: Number(match[2]),
        };
    }
    return refs;
}

async function collectMatrixRefs(
    page: Page,
    workingCopyPath: string,
    bindings: INativeIdentityBinding[],
) {
    const {entries} = await readAnnotationIndex(page, workingCopyPath);
    const freeTextNote = requireNamedEntry(
        entries,
        `evb-note:${matrixStableKeys.freeTextNote}:created:1788048000000`,
        'Text',
    );
    const freeTextEditor = requireNamedEntry(
        entries,
        `evb-freetext:${matrixStableKeys.freeTextEditor}`,
        'FreeText',
    );
    const shapes: Record<string, IAnnotationRef> = {};
    const shapeEntries = await readShapeIndex(page, workingCopyPath);
    for (const [
        subtype,
        stableKey,
    ] of Object.entries(matrixStableKeys.shapes)) {
        const matches = shapeEntries.filter(entry => (
            entry.pageIndex === MATRIX_PAGE_INDEX
            && entry.pdfSubtype === subtype
            && entry.stableKey === stableKey
        ));
        expect(
            matches,
            `missing ${subtype} shape ${stableKey}; page shapes=${JSON.stringify(
                shapeEntries.filter(entry => entry.pageIndex === MATRIX_PAGE_INDEX),
            )}`,
        ).toHaveLength(1);
        shapes[subtype] = toRef(matches[0]!);
    }
    return {
        freeTextEditor: toRef(freeTextEditor),
        freeTextNote: toRef(freeTextNote),
        markup: requireMarkupRefs(bindings),
        shapes,
    } satisfies IMatrixRefs;
}

function createShapes(updated: boolean) {
    const offset = updated ? 0.035 : 0;
    const common = {
        pageIndex: MATRIX_PAGE_INDEX,
        color: updated ? '#0044cc' : '#cc3300',
        fillColor: null,
        opacity: updated ? 0.65 : 0.85,
        strokeWidth: updated ? 4 : 2,
        annotationId: null,
        createdAt: 1_788_048_000_000,
        modifiedAt: updated ? 1_788_048_060_000 : 1_788_048_000_000,
    } as const;
    return [
        {
            ...common,
            type: 'rectangle',
            pdfSubtype: 'Square',
            stableKey: matrixStableKeys.shapes.Square,
            x: 0.08 + offset,
            y: 0.08,
            width: updated ? 0.18 : 0.14,
            height: 0.11,
            x2: null,
            y2: null,
        },
        {
            ...common,
            type: 'circle',
            pdfSubtype: 'Circle',
            stableKey: matrixStableKeys.shapes.Circle,
            x: 0.31 + offset,
            y: 0.08,
            width: updated ? 0.16 : 0.12,
            height: 0.11,
            x2: null,
            y2: null,
        },
        {
            ...common,
            type: 'line',
            pdfSubtype: 'Line',
            stableKey: matrixStableKeys.shapes.Line,
            x: 0.54 + offset,
            y: 0.08,
            width: 0.14,
            height: 0.11,
            x2: 0.7 + offset,
            y2: updated ? 0.22 : 0.18,
            lineStartStyle: 'none',
            lineEndStyle: 'none',
        },
        {
            ...common,
            type: 'polyline',
            pdfSubtype: 'PolyLine',
            stableKey: matrixStableKeys.shapes.PolyLine,
            x: 0.08 + offset,
            y: 0.3,
            width: 0.18,
            height: 0.12,
            x2: null,
            y2: null,
            points: [
                {
                    x: 0.08 + offset,
                    y: 0.3,
                },
                {
                    x: 0.17 + offset,
                    y: updated ? 0.45 : 0.4,
                },
                {
                    x: 0.26 + offset,
                    y: 0.31,
                },
            ],
        },
        {
            ...common,
            type: 'polygon',
            pdfSubtype: 'Polygon',
            stableKey: matrixStableKeys.shapes.Polygon,
            x: 0.35 + offset,
            y: 0.3,
            width: 0.18,
            height: 0.12,
            x2: null,
            y2: null,
            points: [
                {
                    x: 0.35 + offset,
                    y: 0.3,
                },
                {
                    x: 0.44 + offset,
                    y: updated ? 0.46 : 0.42,
                },
                {
                    x: 0.53 + offset,
                    y: 0.3,
                },
            ],
        },
        {
            ...common,
            type: 'polyline',
            pdfSubtype: 'Ink',
            stableKey: matrixStableKeys.shapes.Ink,
            x: 0.62 + offset,
            y: 0.3,
            width: 0.18,
            height: 0.12,
            x2: null,
            y2: null,
            strokes: [[
                {
                    x: 0.62 + offset,
                    y: 0.3,
                },
                {
                    x: 0.7 + offset,
                    y: updated ? 0.46 : 0.42,
                },
                {
                    x: 0.8 + offset,
                    y: 0.31,
                },
            ]],
        },
    ];
}

function createMarkups(updated: boolean, refs?: Record<string, IAnnotationRef>) {
    return Object.entries(matrixStableKeys.markups).map(([
        subtype,
        appAnnotationId,
    ], index) => {
        const left = 0.08 + index * 0.2 + (updated ? 0.025 : 0);
        const markerRect = {
            left,
            top: 0.58,
            width: updated ? 0.15 : 0.12,
            height: 0.035,
        };
        const ref = refs?.[subtype];
        return {
            subtype,
            pageIndex: MATRIX_PAGE_INDEX,
            markerRect,
            markupGeometry: [markerRect],
            appAnnotationId,
            annotationId: ref ? `${ref.objectNumber}R${ref.generationNumber}` : null,
            color: updated ? '#3366ff' : '#ffee00',
            contents: updated
                ? `issue 125 updated ${subtype} contents`
                : `issue 125 created ${subtype} contents`,
            id: appAnnotationId,
            pageMarkupIndex: null,
            source: 'editor',
        };
    });
}

function createMutation(updated: boolean, refs?: IMatrixRefs) {
    const freeTextNoteRect = updated
        ? {
            left: 0.24,
            top: 0.72,
            width: 0.18,
            height: 0.08,
        }
        : {
            left: 0.08,
            top: 0.72,
            width: 0.14,
            height: 0.06,
        };
    return normalizePdfNativeMutationSet({
        ...(refs
            ? {
                updates: [{
                    ...refs.freeTextNote,
                    text: 'issue 125 updated note contents',
                }],
                geometryUpdates: [{
                    ...refs.freeTextNote,
                    pageIndex: MATRIX_PAGE_INDEX,
                    markerRect: freeTextNoteRect,
                }],
            }
            : {freeTextNotes: [{
                pageIndex: MATRIX_PAGE_INDEX,
                stableKey: matrixStableKeys.freeTextNote,
                text: 'issue 125 created note contents',
                markerRect: freeTextNoteRect,
                author: 'Issue 125 acceptance',
                color: '#ffcc00',
                createdAt: 1_788_048_000_000,
            }]}),
        freeTextEditors: [{
            pageIndex: MATRIX_PAGE_INDEX,
            stableKey: matrixStableKeys.freeTextEditor,
            ...(refs ? {annotationId: `${refs.freeTextEditor.objectNumber}R${refs.freeTextEditor.generationNumber}`} : {}),
            text: updated ? 'issue 125 updated FreeText contents' : 'issue 125 created FreeText contents',
            rect: updated
                ? [
                    180,
                    500,
                    330,
                    560,
                ]
                : [
                    80,
                    500,
                    200,
                    545,
                ],
            rotation: updated ? 90 : 0,
            fontSize: updated ? 18 : 14,
            color: updated
                ? [
                    0,
                    68,
                    204,
                ]
                : [
                    204,
                    51,
                    0,
                ],
        }],
        shapes: {
            totalPages: exactFixtureExpectation.pages,
            rewriteShapeState: false,
            shapes: createShapes(updated),
            deletedAnnotationIds: [],
            deletedStableKeys: [],
        },
        markup: {
            overrides: [],
            hints: createMarkups(updated, refs?.markup),
        },
    }, 'issue 125 native annotation matrix');
}

function createDeleteMutation(refs: IMatrixRefs) {
    const annotationRefs = [
        refs.freeTextEditor,
        refs.freeTextNote,
        ...Object.values(refs.markup),
    ];
    return normalizePdfNativeMutationSet({
        deletes: annotationRefs.map(ref => ({
            pageIndex: MATRIX_PAGE_INDEX,
            ...ref,
        })),
        shapes: {
            totalPages: exactFixtureExpectation.pages,
            rewriteShapeState: false,
            shapes: [],
            deletedAnnotationIds: Object.values(refs.shapes).map(ref => `${ref.objectNumber}R${ref.generationNumber}`),
            deletedStableKeys: Object.values(matrixStableKeys.shapes),
        },
    }, 'issue 125 native annotation delete matrix');
}

function expectOneRevision(result: Awaited<ReturnType<typeof applyOneLogicalNativeRevision>>) {
    expect(result.afterStageToken).toBe(result.beforeToken);
    expect(result.afterCommitToken).not.toBe(result.beforeToken);
}

function matrixEntries(entries: IPdfAnnotationIndexEntry[], refs: IMatrixRefs) {
    const expectedRefs = new Set([
        refs.freeTextEditor,
        refs.freeTextNote,
        ...Object.values(refs.markup),
        ...Object.values(refs.shapes),
    ].map(ref => `${ref.objectNumber}R${ref.generationNumber}`));
    return entries.filter(entry => expectedRefs.has(`${entry.objectNumber}R${entry.generationNumber}`));
}

function createPlacedImageFixture(workingCopyPath: string) {
    const imagePath = join(dirname(workingCopyPath), `issue-125-placed-image-${process.pid}.jpg`);
    writeFileSync(imagePath, PLACED_IMAGE_JPEG);
    onTestFinished(() => rmSync(imagePath, {force: true}));
    return imagePath;
}

async function installManagedJpegClipboard(page: Page, imagePath: string) {
    const probe = await page.evaluate(async (input: {imagePath: string;}) => {
        const files = window.electronAPI?.documentFiles;
        if (!files?.createManagedTempFileHandle) {
            throw new Error('Managed image handles are unavailable');
        }
        const handle = await files.createManagedTempFileHandle(input.imagePath);
        const NativeFile = window.File;
        const ManagedFile = new Proxy(NativeFile, {construct(target, args) {
            return Object.assign(Reflect.construct(target, args), {nativeSourceHandle: handle});
        }});
        Object.defineProperty(window, 'File', {
            configurable: true,
            value: ManagedFile,
        });
        const bytes = await files.readFile(input.imagePath);
        const blob = new Blob([bytes as BlobPart], {type: 'image/jpeg'});
        const probeFile = new ManagedFile([blob], 'clipboard-probe.jpg', {type: 'image/jpeg'});
        const bitmap = await createImageBitmap(probeFile);
        const dimensions = {
            height: bitmap.height,
            width: bitmap.width,
        };
        bitmap.close();
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {read: async () => [{
                types: ['image/jpeg'],
                getType: async () => blob,
            }]},
        });
        return {
            dimensions,
            hasNativeSourceHandle: 'nativeSourceHandle' in probeFile,
        };
    }, {imagePath});
    expect(probe).toEqual({
        dimensions: {
            height: 40,
            width: 64,
        },
        hasNativeSourceHandle: true,
    });
}

async function waitForPlacedImageTargetPage(page: Page) {
    await page.waitForFunction((pageNumber: number) => {
        const target = document.querySelector<HTMLElement>(
            `.editor-pane.is-active .workspace-host[data-workspace-active="true"] #pdf-viewer .page_container[data-page="${pageNumber}"]`,
        );
        const rect = target?.getBoundingClientRect();
        return Boolean(rect && rect.width > 100 && rect.height > 100);
    }, {timeout: 30_000}, PLACED_IMAGE_PAGE_NUMBER);
}

async function dragElement(page: Page, selector: string, deltaX: number, deltaY: number) {
    const center = await page.evaluate((input: {selector: string;}) => {
        const element = document.querySelector<HTMLElement>(input.selector);
        if (!element) {
            return null;
        }
        const rect = element.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    }, {selector});
    if (!center) {
        throw new Error(`Placed-image control was not found: ${selector}`);
    }
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + deltaX, center.y + deltaY, {steps: 8});
    await page.mouse.up();
}

async function moveResizeAndEmbedPlacedImage(page: Page) {
    await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
        timeout: 30_000,
        visible: true,
    });
    await page.$eval(ACTIVE_IMAGE_PLACEMENT_SELECTOR, element => {
        element.scrollIntoView({block: 'center'});
    });
    const before = await page.$eval(ACTIVE_IMAGE_PLACEMENT_SELECTOR, element => {
        const rect = element.getBoundingClientRect();
        return {
            height: rect.height,
            left: rect.left,
            top: rect.top,
            width: rect.width,
        };
    });
    await dragElement(page, `${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__surface`, 52, 34);
    const moved = await page.$eval(ACTIVE_IMAGE_PLACEMENT_SELECTOR, element => {
        const rect = element.getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.top,
        };
    });
    expect(Math.abs(moved.left - before.left)).toBeGreaterThan(10);
    expect(Math.abs(moved.top - before.top)).toBeGreaterThan(10);
    await dragElement(page, `${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__resizer--se`, 46, 28);
    const after = await page.$eval(ACTIVE_IMAGE_PLACEMENT_SELECTOR, element => {
        const rect = element.getBoundingClientRect();
        return {
            height: rect.height,
            left: rect.left,
            top: rect.top,
            width: rect.width,
        };
    });
    expect(after.width).toBeGreaterThan(before.width + 10);
    expect(after.height).toBeGreaterThan(before.height + 5);
    await page.click(`${ACTIVE_IMAGE_PLACEMENT_SELECTOR} .pdf-image-placement__action--primary`);
    await page.waitForSelector(ACTIVE_IMAGE_PLACEMENT_SELECTOR, {
        hidden: true,
        timeout: 60_000,
    });
}

function findPlacedImageEntry(entries: IPdfAnnotationIndexEntry[], stableKey?: string) {
    const matches = entries.filter(entry => (
        entry.pageIndex === PLACED_IMAGE_PAGE_NUMBER - 1
        && entry.subtype === 'Stamp'
        && entry.name?.startsWith('placed-image-')
        && (stableKey === undefined || entry.name === stableKey)
    ));
    expect(matches, stableKey ?? 'managed placed image').toHaveLength(1);
    return matches[0]!;
}

async function openPlacedImageContextMenu(page: Page, stableKey: string) {
    await scrollViewerToPage(page, PLACED_IMAGE_PAGE_NUMBER);
    await openAnnotationsTab(page, 30_000);
    const bounds = await page.evaluate((expectedStableKey, pageNumber) => {
        const pageSelector = `.page_container[data-page="${pageNumber}"]`;
        const host = globalThis.__evbE2E.getActiveWorkspaceHost(pageSelector);
        const pageContainer = host?.querySelector<HTMLElement>(pageSelector) ?? null;
        const stamp = Array.from(pageContainer?.querySelectorAll<HTMLElement>(
            '.pdf-annotation-editor-stamp',
        ) ?? []).find((candidate) => candidate.dataset.annotationId === expectedStableKey);
        if (!stamp) {
            return null;
        }
        const rect = stamp.getBoundingClientRect();
        const style = window.getComputedStyle(stamp);
        const isVisible = style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || '1') > 0
            && rect.width > 0
            && rect.height > 0
            && rect.bottom > 0
            && rect.top < window.innerHeight
            && rect.right > 0
            && rect.left < window.innerWidth;
        if (!isVisible) {
            return null;
        }
        return {
            height: rect.height,
            width: rect.width,
            x: rect.x,
            y: rect.y,
        };
    }, stableKey, PLACED_IMAGE_PAGE_NUMBER);
    if (!bounds) {
        throw new Error(`Placed-image editor entity was not found for ${stableKey}`);
    }
    await page.mouse.click(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        {button: 'right'},
    );
    await page.waitForSelector('.annotation-context-menu', {
        timeout: 10_000,
        visible: true,
    });
}

async function clickPlacedImageContextAction(page: Page, text: string) {
    const clicked = await page.evaluate((expectedText: string) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-context-menu .pdf-context-menu__action',
        )).find(candidate => (candidate.textContent ?? '').trim() === expectedText);
        if (!button || button.disabled) {
            return false;
        }
        button.click();
        return true;
    }, text);
    expect(clicked, `context action ${text}`).toBe(true);
}

async function savePlacedImageRevision(page: Page, documentPath: string, label: string) {
    const event = await saveViaVisibleToolbarWithDeadline(
        page,
        PLACED_IMAGE_SAVE_TIMEOUT_MS,
        documentPath,
        {label},
    );
    expect(event.detail.documentRevisionToken).toEqual(expect.any(String));
    await execFileAsync('qpdf', [
        '--check',
        documentPath,
    ], {timeout: 60_000});
    return event.detail.documentRevisionToken;
}

async function collectPlacedImageGraphRefs(documentPath: string, stampRef: IAnnotationRef) {
    const refs = new Map<string, IAnnotationRef>();
    const add = (ref: IAnnotationRef) => refs.set(`${ref.objectNumber}R${ref.generationNumber}`, ref);
    add(stampRef);
    const stampObject = await readObject(documentPath, stampRef);
    const appearanceMatch = /\/N\s+(\d+)\s+(\d+)\s+R/u.exec(stampObject);
    if (!appearanceMatch) {
        throw new Error(`Placed-image Stamp has no normal appearance: ${stampObject}`);
    }
    const appearanceRef = {
        objectNumber: Number(appearanceMatch[1]),
        generationNumber: Number(appearanceMatch[2]),
    };
    add(appearanceRef);
    const appearanceObject = await readObjectDictionary(documentPath, appearanceRef);
    for (const match of appearanceObject.matchAll(/\/(?:Im\d+|Image)\s+(\d+)\s+(\d+)\s+R/gu)) {
        add({
            objectNumber: Number(match[1]),
            generationNumber: Number(match[2]),
        });
    }
    expect(refs.size).toBeGreaterThanOrEqual(3);
    return {
        object: stampObject,
        refs: Array.from(refs.values()),
    };
}

largePdfDescribe('Electron E2E - exact large PDF native annotation matrix', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-issue-125-native-matrix-${Date.now()}`,
        timeoutMs: MATRIX_TIMEOUT_MS,
        extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
    });

    it('creates, updates, deletes, recreates, and hard-reopens every projected native annotation kind', async () => {
        const initialSession = sessionFixture.getSession();
        if (!initialSession || !fixture.path) {
            throw new Error(`Exact large fixture is unavailable: ${fixture.reason}`);
        }
        const sourceIdentity = await readExactPdfFixtureIdentity(fixture.path, {timeoutMs: MATRIX_TIMEOUT_MS});
        validateExactPdfFixtureIdentity(sourceIdentity, exactFixtureExpectation);
        expect(sourceIdentity.pages).toBe(882);
        const documentPath = copyExactFixture(fixture.path);

        await openPdfInApp(initialSession.page, documentPath, MATRIX_TIMEOUT_MS);
        await waitForPdfLoaded(initialSession.page, MATRIX_TIMEOUT_MS);
        await waitForViewerInteractive(initialSession.page, MATRIX_TIMEOUT_MS);
        const workingCopyPath = await readWorkingCopyPath(initialSession.page);

        const created = await applyOneLogicalNativeRevision(
            initialSession.page,
            workingCopyPath,
            createMutation(false),
        );
        expectOneRevision(created);
        let refs = await collectMatrixRefs(
            initialSession.page,
            workingCopyPath,
            created.identityBindings,
        );

        const updated = await applyOneLogicalNativeRevision(
            initialSession.page,
            workingCopyPath,
            createMutation(true, refs),
        );
        expectOneRevision(updated);
        const updatedIndex = await readAnnotationIndex(initialSession.page, workingCopyPath);
        expect(matrixEntries(updatedIndex.entries, refs)).toHaveLength(12);
        const updatedNoteObject = await readObject(workingCopyPath, refs.freeTextNote);
        const updatedEditorObject = await readObject(workingCopyPath, refs.freeTextEditor);
        expect(qpdfObjectContainsText(updatedNoteObject, 'issue 125 updated note contents')).toBe(true);
        expect(qpdfObjectContainsText(updatedEditorObject, 'issue 125 updated FreeText contents')).toBe(true);
        for (const ref of Object.values(refs.markup)) {
            expect(qpdfObjectContainsText(
                await readObject(workingCopyPath, ref),
                'issue 125 updated',
            )).toBe(true);
        }

        const deleted = await applyOneLogicalNativeRevision(
            initialSession.page,
            workingCopyPath,
            createDeleteMutation(refs),
        );
        expectOneRevision(deleted);
        const deletedIndex = await readAnnotationIndex(initialSession.page, workingCopyPath);
        expect(matrixEntries(deletedIndex.entries, refs)).toHaveLength(0);
        await execFileAsync('qpdf', [
            '--check',
            documentPath,
        ], {timeout: 60_000});

        await waitForCrashCheckpoint(initialSession.name, documentPath);
        let restarted = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!restarted) {
            throw new Error('Hard restart after native annotation deletion failed');
        }
        await waitForPdfLoaded(restarted.page, MATRIX_TIMEOUT_MS);
        await waitForViewerInteractive(restarted.page, MATRIX_TIMEOUT_MS);
        let reopenedWorkingCopyPath = await readWorkingCopyPath(restarted.page);
        const reopenedDeletedIndex = await readAnnotationIndex(restarted.page, reopenedWorkingCopyPath);
        expect(matrixEntries(reopenedDeletedIndex.entries, refs)).toHaveLength(0);

        const recreated = await applyOneLogicalNativeRevision(
            restarted.page,
            reopenedWorkingCopyPath,
            createMutation(false),
        );
        expectOneRevision(recreated);
        refs = await collectMatrixRefs(
            restarted.page,
            reopenedWorkingCopyPath,
            recreated.identityBindings,
        );
        expect(Object.keys(refs.shapes)).toHaveLength(6);
        expect(Object.keys(refs.markup)).toHaveLength(4);

        await waitForCrashCheckpoint(restarted.name, documentPath);
        restarted = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!restarted) {
            throw new Error('Hard restart after native annotation recreation failed');
        }
        await waitForPdfLoaded(restarted.page, MATRIX_TIMEOUT_MS);
        await waitForViewerInteractive(restarted.page, MATRIX_TIMEOUT_MS);
        reopenedWorkingCopyPath = await readWorkingCopyPath(restarted.page);
        const reopenedRefs = await collectMatrixRefs(
            restarted.page,
            reopenedWorkingCopyPath,
            recreated.identityBindings,
        );
        expect(reopenedRefs).toEqual(refs);
        await execFileAsync('qpdf', [
            '--check',
            documentPath,
        ], {timeout: 60_000});
    }, MATRIX_TIMEOUT_MS);

    it('inserts, moves, resizes, updates, deletes, saves, and hard-reopens a placed image', async () => {
        let session = await sessionFixture.restart({clean: true});
        if (!session || !fixture.path) {
            throw new Error(`Exact large fixture is unavailable: ${fixture.reason}`);
        }
        const sourceIdentity = await readExactPdfFixtureIdentity(fixture.path, {timeoutMs: MATRIX_TIMEOUT_MS});
        validateExactPdfFixtureIdentity(sourceIdentity, exactFixtureExpectation);
        expect(sourceIdentity.pages).toBe(882);
        const documentPath = copyExactFixture(fixture.path);

        await openPdfInApp(session.page, documentPath, MATRIX_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, MATRIX_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, MATRIX_TIMEOUT_MS);
        const initialWorkingCopyPath = await readWorkingCopyPath(session.page);
        const imagePath = createPlacedImageFixture(initialWorkingCopyPath);
        await scrollViewerToPage(session.page, PLACED_IMAGE_PAGE_NUMBER);
        await waitForPlacedImageTargetPage(session.page);
        await installManagedJpegClipboard(session.page, imagePath);
        const pasteResult = await callWorkspaceCommand<undefined>(
            session.page,
            'handlePasteImageFromClipboard',
        );
        expect(pasteResult.called).toBe(true);
        await moveResizeAndEmbedPlacedImage(session.page);
        const firstRevisionToken = await savePlacedImageRevision(
            session.page,
            documentPath,
            'issue 125 placed-image create save',
        );
        const firstWorkingCopyPath = await readWorkingCopyPath(session.page);
        const firstIndex = await readAnnotationIndex(session.page, firstWorkingCopyPath);
        expect(firstIndex.revisionToken).toBe(firstRevisionToken);
        const firstEntry = findPlacedImageEntry(firstIndex.entries);
        const stableKey = firstEntry.name!;
        const firstGraph = await collectPlacedImageGraphRefs(documentPath, toRef(firstEntry));

        await waitForCrashCheckpoint(session.name, documentPath);
        session = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!session) {
            throw new Error('Hard restart after placed-image creation failed');
        }
        await waitForPdfLoaded(session.page, MATRIX_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, MATRIX_TIMEOUT_MS);
        const firstReopenedWorkingCopyPath = await readWorkingCopyPath(session.page);
        const firstReopenedIndex = await readAnnotationIndex(session.page, firstReopenedWorkingCopyPath);
        expect(toRef(findPlacedImageEntry(firstReopenedIndex.entries, stableKey))).toEqual(toRef(firstEntry));

        await installManagedJpegClipboard(session.page, imagePath);
        await openPlacedImageContextMenu(session.page, stableKey);
        await clickPlacedImageContextAction(session.page, 'Paste Image from Clipboard');
        await moveResizeAndEmbedPlacedImage(session.page);
        const updatedRevisionToken = await savePlacedImageRevision(
            session.page,
            documentPath,
            'issue 125 placed-image update save',
        );
        expect(updatedRevisionToken).not.toBe(firstRevisionToken);
        const updatedWorkingCopyPath = await readWorkingCopyPath(session.page);
        const updatedIndex = await readAnnotationIndex(session.page, updatedWorkingCopyPath);
        const updatedEntry = findPlacedImageEntry(updatedIndex.entries, stableKey);
        expect(toRef(updatedEntry)).toEqual(toRef(firstEntry));
        const updatedGraph = await collectPlacedImageGraphRefs(documentPath, toRef(updatedEntry));
        expect(updatedGraph.object).not.toBe(firstGraph.object);

        await waitForCrashCheckpoint(session.name, documentPath);
        session = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!session) {
            throw new Error('Hard restart after placed-image update failed');
        }
        await waitForPdfLoaded(session.page, MATRIX_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, MATRIX_TIMEOUT_MS);
        const updatedReopenedPath = await readWorkingCopyPath(session.page);
        const updatedReopenedIndex = await readAnnotationIndex(session.page, updatedReopenedPath);
        expect(toRef(findPlacedImageEntry(updatedReopenedIndex.entries, stableKey))).toEqual(toRef(updatedEntry));

        await openPlacedImageContextMenu(session.page, stableKey);
        await clickPlacedImageContextAction(session.page, 'Delete Image');
        const deletedRevisionToken = await savePlacedImageRevision(
            session.page,
            documentPath,
            'issue 125 placed-image delete save',
        );
        expect(deletedRevisionToken).not.toBe(updatedRevisionToken);
        const deletedWorkingCopyPath = await readWorkingCopyPath(session.page);
        const deletedIndex = await readAnnotationIndex(session.page, deletedWorkingCopyPath);
        expect(deletedIndex.entries.filter(entry => entry.name === stableKey)).toHaveLength(0);

        await waitForCrashCheckpoint(session.name, documentPath);
        session = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!session) {
            throw new Error('Hard restart after placed-image deletion failed');
        }
        await waitForPdfLoaded(session.page, MATRIX_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, MATRIX_TIMEOUT_MS);
        const deletedReopenedPath = await readWorkingCopyPath(session.page);
        const deletedReopenedIndex = await readAnnotationIndex(session.page, deletedReopenedPath);
        expect(deletedReopenedIndex.entries.filter(entry => entry.name === stableKey)).toHaveLength(0);
        const graphRefs = new Map<string, IAnnotationRef>();
        for (const ref of [
            ...firstGraph.refs,
            ...updatedGraph.refs,
        ]) {
            graphRefs.set(`${ref.objectNumber}R${ref.generationNumber}`, ref);
        }
        for (const ref of graphRefs.values()) {
            expect((await readObject(documentPath, ref)).trim()).toBe('null');
        }
    }, MATRIX_TIMEOUT_MS);
});
