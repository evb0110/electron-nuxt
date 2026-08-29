import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {
    constants,
    copyFileSync,
    createReadStream,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
} from 'node:fs';
import {
    execFile,
    execFileSync,
} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import {promisify} from 'node:util';
import { delay } from 'es-toolkit/promise';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFRef,
    PDFString,
} from 'pdf-lib';
import type {Page} from 'puppeteer-core';
import {
    PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES,
    type IPdfAnnotationIndexEntry,
    type IPdfAnnotationIndexSession,
} from '@contracts/electronApiDocuments';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import {
    copyLargePdfFixture,
    resolveLargePdfFixtureAvailability,
    selectFixtureDescribe,
} from '@tests/e2e/electron/helpers/fixtures';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    goToPageViaToolbar,
    openAnnotationsTab,
    openPdfInApp,
    saveViaVisibleToolbar,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    clickAnnotationTool,
    createFreeTextAnnotation,
    createFreeTextAnnotationWithPointer,
    createStickyNoteWithPointer,
    waitForNoOpenNoteWindows,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import { workspaceCrashCheckpointPath } from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {resolveExactPdfFixtureExpectation} from '@scripts/ci/stageExactPdfFixture';
import {getSessionInfo} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    collectDescendantPidsUnix,
    isProcessAlive,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    callWorkspaceCommand,
    collectWorkspaceExposeDebugState,
    getWorkspaceToolbarSnapshot,
    installWorkspaceExposeProbe,
    readWorkspaceStateValues,
    waitForSaveFrontierReady,
    type IWorkspaceExpose,
    type IWorkspaceExposeProbeWindow,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const LARGE_PDF_TIMEOUT_MS = 360_000;
const LARGE_PDF_SAVE_TIMEOUT_MS = 8_000;
const NOTE_TEXT_ENTRY_TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);
const EXACT_ZALIZNYAK_REQUIRED_ENV = 'EVB_E2E_REQUIRE_EXACT_ZALIZNYAK';
const EXACT_ZALIZNYAK_EXPECTATION = resolveExactPdfFixtureExpectation();
const ANNOTATION_INDEX_CHUNK_BYTES = 512 * 1_024;
const IPC_PAYLOAD_MAX_BYTES = 8 * 1_024 * 1_024;
const LARGE_PDF_ARTIFACT_ROOT_ENV = 'EVB_E2E_LARGE_PDF_ARTIFACT_ROOT';
const largePdfFixture = resolveLargePdfFixtureAvailability();
const largePdfDescribe = selectFixtureDescribe(describe, largePdfFixture);
const qpdfAvailable = (() => {
    try {
        execFileSync('qpdf', ['--version'], {stdio: 'ignore'});
        return true;
    } catch {
        return false;
    }
})();
const runStickyRestartScenario = qpdfAvailable
    || process.env[EXACT_ZALIZNYAK_REQUIRED_ENV] === '1';

interface ICommentAtPointViewer {commentAtPoint?: (
    pageNumber: number,
    pageX: number,
    pageY: number,
    options?: { preferTextAnchor?: boolean },
) => Promise<boolean>;}

interface IPdfAnnotationModifiedIdsDebugState {ids?: Set<unknown>;}
interface IPdfAnnotationSerializableDebugState {map?: Map<unknown, unknown>;}
interface IPdfAnnotationStorageDebugState {
    modifiedIds?: IPdfAnnotationModifiedIdsDebugState;
    serializable?: IPdfAnnotationSerializableDebugState;
}
interface IPdfDocumentDebugState {annotationStorage?: IPdfAnnotationStorageDebugState;}
interface IAgentActionResult extends Record<string, unknown> {
    comment?: Record<string, unknown>;
    created?: boolean;
    markerRect?: unknown;
    tabId?: string;
}

interface IAnnotationIndexRead {
    chunkByteLengths: number[];
    entries: IPdfAnnotationIndexEntry[];
    session: IPdfAnnotationIndexSession;
    transportPayloadByteLengths: number[];
}

interface IVerifiedStickyNote {
    annotation: IPdfAnnotationIndexEntry;
    annotationObject: string;
    appearanceRef: {
        generationNumber: number;
        objectNumber: number
    };
    name: string;
    popup: IPdfAnnotationIndexEntry;
    rect: [number, number, number, number];
}

interface IStagedArtifactCaptureWindow extends Window {
    __largePdfStagedArtifactCapture?: {artifact: ITypedStagedArtifact | null;};
    __resumeLargePdfStagedArtifactCommit?: () => void;
}

async function installStagedArtifactCapture(page: Page) {
    await page.evaluate(() => {
        const captureWindow = window as IStagedArtifactCaptureWindow;
        captureWindow.__largePdfStagedArtifactCapture = {artifact: null};
        let resumeCommit = () => {};
        const commitBarrier = new Promise<void>((resolve) => {
            resumeCommit = resolve;
        });
        captureWindow.__resumeLargePdfStagedArtifactCommit = resumeCommit;
        captureWindow.__stagedPdfNativeMutationCommitBarrierForAutomation = async (artifact) => {
            const capture = captureWindow.__largePdfStagedArtifactCapture;
            if (capture) {
                capture.artifact = artifact;
            }
            await commitBarrier;
        };
    });
}

async function waitForStagedArtifact(page: Page) {
    await page.waitForFunction(
        () => (window as IStagedArtifactCaptureWindow).__largePdfStagedArtifactCapture?.artifact !== null,
        {timeout: LARGE_PDF_SAVE_TIMEOUT_MS},
    );
    const artifact = await page.evaluate(
        () => (window as IStagedArtifactCaptureWindow).__largePdfStagedArtifactCapture?.artifact ?? null,
    );
    if (!artifact) {
        throw new Error('Native save did not expose its staged artifact');
    }
    return artifact;
}

async function resumeStagedArtifactCommit(page: Page) {
    await page.evaluate(() => {
        (window as IStagedArtifactCaptureWindow).__resumeLargePdfStagedArtifactCommit?.();
    });
}

function hashFileSha256(filePath: string, maxBytes?: number) {
    return new Promise<string>((resolve, reject) => {
        const digest = createHash('sha256');
        const input = maxBytes === undefined
            ? createReadStream(filePath)
            : createReadStream(filePath, {end: maxBytes - 1});
        input.on('data', chunk => digest.update(chunk));
        input.on('error', reject);
        input.on('end', () => resolve(digest.digest('hex')));
    });
}

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

function readSessionProcessSnapshot(sessionName: string) {
    const info = getSessionInfo(sessionName);
    const rootPid = info?.electronPid ?? info?.pid ?? null;
    if (!rootPid) {
        throw new Error(`Electron E2E session '${sessionName}' has no live process identity`);
    }
    return {
        pids: [
            rootPid,
            ...collectDescendantPidsUnix(rootPid),
        ],
        rootPid,
    };
}

async function expectProcessesExited(pids: readonly number[]) {
    await expect.poll(() => pids.filter(isProcessAlive), {
        interval: 100,
        timeout: 15_000,
    }).toEqual([]);
}

async function waitForCrashCheckpointPath(sessionName: string, expectedPath: string) {
    const expectedRealPath = realpathSync(expectedPath);
    await expect.poll(() => {
        try {
            const stored = JSON.parse(readFileSync(workspaceCrashCheckpointPath(sessionName), 'utf8')) as {checkpoint?: {tabs?: Array<{sourceRef?: string | null;}>;};};
            return stored.checkpoint?.tabs?.some(tab => (
                typeof tab.sourceRef === 'string'
                && realpathSync(tab.sourceRef) === expectedRealPath
            )) ?? false;
        } catch {
            return false;
        }
    }, {timeout: 10_000}).toBe(true);
}

async function waitForRestoredDocument(page: Page, expectedPath: string) {
    const expectedRealPath = realpathSync(expectedPath);
    await expect.poll(async () => {
        const state = await readWorkspaceStateValues<{originalPath?: string | null;}>(
            page,
            ['originalPath'],
        );
        return typeof state.originalPath === 'string'
            ? realpathSync(state.originalPath)
            : null;
    }, {timeout: LARGE_PDF_TIMEOUT_MS}).toBe(expectedRealPath);
    await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
    await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
}

async function expectCleanAnnotationHydration(page: Page) {
    await expect.poll(async () => {
        const state = await readWorkspaceStateValues<{dirtyState?: {
            annotationDirty: boolean;
            fileDirty: boolean;
            hasAnnotationChanges: boolean;
            hasLivePdfJsAnnotationChanges: boolean;
            hasPendingUnsavedChanges: boolean;
            hasSavedPdfJsAnnotationBaselineChanges: boolean;
            pdfJsAnnotationStorage: {
                hasChanges: boolean;
                ids: string[];
            } | null;
        };}>(page, ['dirtyState']);
        const dirty = state.dirtyState;
        return Boolean(dirty)
            && dirty?.annotationDirty === false
            && dirty.fileDirty === false
            && dirty.hasAnnotationChanges === false
            && dirty.hasLivePdfJsAnnotationChanges === false
            && dirty.hasPendingUnsavedChanges === false
            && dirty.hasSavedPdfJsAnnotationBaselineChanges === false
            && dirty.pdfJsAnnotationStorage !== null
            && (
                dirty.pdfJsAnnotationStorage.hasChanges === false
                && dirty.pdfJsAnnotationStorage.ids.length === 0
            );
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);
}

async function readVisibleStickyNoteSession(page: Page, expectedText: string) {
    return page.evaluate((text) => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const isVisible = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        };
        const textarea = Array.from(
            host?.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea') ?? [],
        ).find(candidate => candidate.value === text && isVisible(candidate)) ?? null;
        return {
            markerCount: Array.from(host?.querySelectorAll<HTMLElement>(
                '.pdf-comment-marker-button',
            ) ?? []).filter(isVisible).length,
            text: textarea?.value ?? null,
        };
    }, expectedText);
}

async function readDocumentSaveIdentity(page: Page) {
    return page.evaluate(async () => {
        const documentFiles = window.electronAPI?.documentFiles;
        if (!documentFiles) {
            throw new Error('Document file capability is unavailable in the renderer');
        }
        const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({requiredProperties: ['workingCopyPath']}) as {workingCopyPath?: string | null} | null;
        const workingCopyPath = workspace?.workingCopyPath ?? null;
        if (!workingCopyPath) {
            throw new Error('The restored workspace has no path-backed working copy');
        }
        return {
            revision: await documentFiles.getDocumentRevision(workingCopyPath),
            workingCopyPath,
        };
    });
}

async function qpdfCheck(filePath: string) {
    await execFileAsync('qpdf', [
        '--check',
        filePath,
    ], {
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
    });
}

async function qpdfPageCount(filePath: string) {
    const {stdout} = await execFileAsync('qpdf', [
        '--show-npages',
        filePath,
    ], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 120_000,
    });
    const pageCount = Number.parseInt(stdout.trim(), 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error(`qpdf returned an invalid page count: ${JSON.stringify(stdout)}`);
    }
    return pageCount;
}

async function admitExactZaliznyakFixture(filePath: string) {
    if (process.env[EXACT_ZALIZNYAK_REQUIRED_ENV] !== '1') {
        return null;
    }
    const identity = {
        bytes: statSync(filePath).size,
        pages: await qpdfPageCount(filePath),
        sha256: await hashFileSha256(filePath),
    };
    expect(identity).toEqual({
        bytes: EXACT_ZALIZNYAK_EXPECTATION.bytes,
        pages: EXACT_ZALIZNYAK_EXPECTATION.pages,
        sha256: EXACT_ZALIZNYAK_EXPECTATION.sha256,
    });
    await qpdfCheck(filePath);
    return identity;
}

async function readBoundedAnnotationIndex(
    page: Page,
    documentPath: string,
    expectedRevisionToken?: string,
): Promise<IAnnotationIndexRead> {
    const result = await page.evaluate(async (input: {
        chunkBytes: number;
        documentPath: string;
        payloadBudget: number;
    }) => {
        const documentFiles = window.electronAPI?.documentFiles;
        if (
            !documentFiles
            || typeof documentFiles.beginPdfAnnotationIndex !== 'function'
            || typeof documentFiles.readPdfAnnotationIndexChunk !== 'function'
            || typeof documentFiles.releasePdfAnnotationIndex !== 'function'
        ) {
            throw new Error('PDF annotation index capability is unavailable in the renderer');
        }

        const revision = await documentFiles.getDocumentRevision(input.documentPath);
        const session = await documentFiles.beginPdfAnnotationIndex(input.documentPath, {expectedDocumentRevisionToken: revision.token});
        const entries: IPdfAnnotationIndexEntry[] = [];
        const chunkByteLengths: number[] = [];
        const transportPayloadByteLengths: number[] = [];
        let offset = 0;
        let released = false;
        try {
            while (true) {
                const chunk = await documentFiles.readPdfAnnotationIndexChunk(
                    session.sessionId,
                    offset,
                    {chunkBytes: input.chunkBytes},
                );
                if (chunk.offset !== offset) {
                    throw new Error(`PDF annotation index offset mismatch: ${chunk.offset} !== ${offset}`);
                }
                const transportBytes = new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
                if (
                    chunk.byteLength < 0
                    || chunk.byteLength > input.payloadBudget
                    || transportBytes < 1
                    || transportBytes > input.payloadBudget
                ) {
                    throw new Error(`PDF annotation index exceeded ${input.payloadBudget} bytes`);
                }
                chunkByteLengths.push(chunk.byteLength);
                transportPayloadByteLengths.push(transportBytes);
                entries.push(...chunk.entries);
                if (chunk.done) {
                    if (chunk.nextOffset !== null) {
                        throw new Error('Completed annotation index chunk has a next offset');
                    }
                    break;
                }
                if (chunk.nextOffset === null || chunk.nextOffset <= offset) {
                    throw new Error('PDF annotation index chunk offset did not advance');
                }
                offset = chunk.nextOffset;
            }
        } finally {
            released = await documentFiles.releasePdfAnnotationIndex(session.sessionId);
        }
        if (!released) {
            throw new Error('PDF annotation index session was not released');
        }
        return {
            chunkByteLengths,
            entries,
            session,
            transportPayloadByteLengths,
        };
    }, {
        chunkBytes: ANNOTATION_INDEX_CHUNK_BYTES,
        documentPath,
        payloadBudget: IPC_PAYLOAD_MAX_BYTES,
    });
    const read = result as IAnnotationIndexRead;
    if (expectedRevisionToken) {
        expect(read.session.documentRevisionToken).toBe(expectedRevisionToken);
    }
    return read;
}

async function readQpdfObject(
    filePath: string,
    objectRef: {
        generationNumber: number;
        objectNumber: number
    },
    streamData: 'filtered' | 'none' | 'raw' = 'raw',
) {
    const {stdout} = await execFileAsync('qpdf', [
        `--show-object=${objectRef.objectNumber},${objectRef.generationNumber}`,
        ...(streamData === 'filtered'
            ? ['--filtered-stream-data']
            : streamData === 'raw'
                ? ['--raw-stream-data']
                : []),
        filePath,
    ], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
    });
    return stdout;
}

function parseRectFromQpdfObject(value: string): [number, number, number, number] {
    const match = value.match(/\/Rect\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/u);
    if (!match) {
        throw new Error(`Annotation object has no bounded /Rect: ${value.slice(0, 1000)}`);
    }
    const rect = match.slice(1).map(Number) as [number, number, number, number];
    if (rect.some(coordinate => !Number.isFinite(coordinate)) || rect[2] <= rect[0] || rect[3] <= rect[1]) {
        throw new Error(`Annotation object has an invalid /Rect: ${JSON.stringify(rect)}`);
    }
    return rect;
}

function parseAppearanceRefFromQpdfObject(value: string) {
    const match = value.match(/\/AP\s*<<[\s\S]*?\/N\s+(\d+)\s+(\d+)\s+R/u);
    if (!match) {
        throw new Error(`Annotation object has no indirect normal appearance: ${value.slice(0, 1000)}`);
    }
    return {
        objectNumber: Number(match[1]),
        generationNumber: Number(match[2]),
    };
}

function findQpdfLiteralStringEnd(value: string, start: number) {
    let depth = 0;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const character = value[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (character === '\\') {
            escaped = true;
            continue;
        }
        if (character === '(') {
            depth += 1;
        } else if (character === ')') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function readQpdfDictionaryString(value: string, key: string) {
    let dictionaryDepth = 0;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        const nextCharacter = value[index + 1];
        if (character === '<' && nextCharacter === '<') {
            dictionaryDepth += 1;
            index += 1;
            continue;
        }
        if (character === '>' && nextCharacter === '>') {
            dictionaryDepth = Math.max(0, dictionaryDepth - 1);
            index += 1;
            continue;
        }
        if (character === '(') {
            const end = findQpdfLiteralStringEnd(value, index);
            if (end < 0) {
                return null;
            }
            index = end;
            continue;
        }
        if (character === '<') {
            const end = value.indexOf('>', index + 1);
            if (end < 0) {
                return null;
            }
            index = end;
            continue;
        }
        if (character !== '/' || dictionaryDepth !== 1) {
            continue;
        }

        let nameEnd = index + 1;
        while (nameEnd < value.length) {
            const nameCharacter = value[nameEnd] ?? '';
            if (/\s/u.test(nameCharacter) || '[]()<>/{}/'.includes(nameCharacter)) {
                break;
            }
            nameEnd += 1;
        }
        if (value.slice(index + 1, nameEnd) !== key) {
            index = nameEnd - 1;
            continue;
        }

        let tokenStart = nameEnd;
        while (/\s/u.test(value[tokenStart] ?? '')) {
            tokenStart += 1;
        }
        const tokenStartCharacter = value[tokenStart];
        if (tokenStartCharacter === '(') {
            const tokenEnd = findQpdfLiteralStringEnd(value, tokenStart);
            return tokenEnd < 0 ? null : value.slice(tokenStart, tokenEnd + 1);
        }
        if (tokenStartCharacter === '<' && value[tokenStart + 1] !== '<') {
            const tokenEnd = value.indexOf('>', tokenStart + 1);
            return tokenEnd < 0 ? null : value.slice(tokenStart, tokenEnd + 1);
        }
        return null;
    }
    return null;
}

function decodeQpdfLiteralString(value: string) {
    let decoded = '';
    for (let index = 1; index < value.length - 1; index += 1) {
        const character = value[index];
        if (character !== '\\') {
            decoded += character;
            continue;
        }
        const escaped = value[index + 1];
        if (escaped === undefined) {
            break;
        }
        index += 1;
        const simpleEscape = {
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
            '(': '(',
            ')': ')',
            '\\': '\\',
        }[escaped];
        if (simpleEscape !== undefined) {
            decoded += simpleEscape;
            continue;
        }
        if (/[0-7]/u.test(escaped)) {
            let octal = escaped;
            while (octal.length < 3 && /[0-7]/u.test(value[index + 1] ?? '')) {
                index += 1;
                octal += value[index];
            }
            decoded += String.fromCharCode(Number.parseInt(octal, 8));
            continue;
        }
        decoded += escaped;
    }
    return decoded;
}

function qpdfStringTokenContainsText(value: string, text: string) {
    if (value.startsWith('(')) {
        return decodeQpdfLiteralString(value).includes(text);
    }
    if (!value.startsWith('<')) {
        return false;
    }
    const normalized = value.slice(1, -1).replace(/\s+/gu, '').toLowerCase();
    return normalized.includes(toPdfUtf16BeHex(text))
        || normalized.includes(Buffer.from(text, 'utf8').toString('hex'));
}

function qpdfDictionaryContainsText(value: string, key: string, text: string) {
    const stringValue = readQpdfDictionaryString(value, key);
    return stringValue !== null && qpdfStringTokenContainsText(stringValue, text);
}

async function verifyStickyNoteStructure(
    page: Page,
    filePath: string,
    expectedText: string,
    expectedPageIndex = 0,
    expectedRevisionToken?: string,
    indexPath = filePath,
): Promise<IVerifiedStickyNote> {
    const index = await readBoundedAnnotationIndex(page, indexPath, expectedRevisionToken);
    if (process.env[EXACT_ZALIZNYAK_REQUIRED_ENV] === '1') {
        expect(index.session.pageCount).toBe(EXACT_ZALIZNYAK_EXPECTATION.pages);
    } else {
        expect(index.session.pageCount).toBeGreaterThan(0);
    }
    expect(ANNOTATION_INDEX_CHUNK_BYTES).toBeLessThanOrEqual(PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES);
    expect(index.chunkByteLengths.length).toBeGreaterThan(0);
    expect(index.transportPayloadByteLengths.every(bytes => bytes > 0 && bytes <= IPC_PAYLOAD_MAX_BYTES)).toBe(true);

    const candidates = index.entries.filter(entry => (
        entry.pageIndex === expectedPageIndex
        && entry.subtype === 'FreeText'
        && entry.popupRef !== null
        && typeof entry.name === 'string'
        && entry.name.length > 0
    ));
    const matches: Array<{
        annotation: IPdfAnnotationIndexEntry;
        annotationObject: string
    }> = [];
    const candidateObjects: Array<{
        annotation: IPdfAnnotationIndexEntry;
        annotationObject: string;
    }> = [];
    for (const annotation of candidates) {
        const annotationObject = await readQpdfObject(filePath, annotation);
        candidateObjects.push({
            annotation,
            annotationObject,
        });
        if (qpdfDictionaryContainsText(annotationObject, 'Contents', expectedText)) {
            matches.push({
                annotation,
                annotationObject,
            });
        }
    }
    expect(matches, JSON.stringify({
        candidates,
        candidateObjects,
        expectedText,
    })).toHaveLength(1);
    const match = matches[0];
    if (!match || !match.annotation.popupRef || !match.annotation.name) {
        throw new Error('Verified sticky note lost its identity or Popup reference');
    }
    const popup = index.entries.find(entry => (
        entry.objectNumber === match.annotation.popupRef?.objectNumber
        && entry.generationNumber === match.annotation.popupRef.generationNumber
        && entry.subtype === 'Popup'
    ));
    if (!popup) {
        throw new Error('Verified sticky note Popup is absent from the bounded annotation index');
    }
    expect(popup.parentRef).toEqual({
        objectNumber: match.annotation.objectNumber,
        generationNumber: match.annotation.generationNumber,
    });
    const popupObject = await readQpdfObject(filePath, popup);
    expect(qpdfDictionaryContainsText(popupObject, 'Contents', expectedText)).toBe(true);
    expect(popupObject).toMatch(new RegExp(`/Parent\\s+${match.annotation.objectNumber}\\s+${match.annotation.generationNumber}\\s+R`, 'u'));

    const rect = parseRectFromQpdfObject(match.annotationObject);
    const appearanceRef = parseAppearanceRefFromQpdfObject(match.annotationObject);
    const appearanceObject = await readQpdfObject(filePath, appearanceRef, 'none');
    const appearanceStream = await readQpdfObject(filePath, appearanceRef, 'filtered');
    expect(appearanceObject).toMatch(/\/Type\s*\/XObject/u);
    expect(appearanceObject).toMatch(/\/Subtype\s*\/Form/u);
    expect(appearanceObject).toMatch(/\/BBox\s*\[\s*0\s+0\s+0\s+0\s*\]/u);
    // Sticky-note FreeText annotations deliberately use a shared blank form.
    // The visible marker is rendered by the comment UI, not by this PDF form.
    expect(appearanceStream).toBe('');
    expect(qpdfDictionaryContainsText(match.annotationObject, 'Contents', expectedText)).toBe(true);
    expect(match.annotationObject).toMatch(/\/NM\s*(?:\(|<)/u);
    return {
        annotation: match.annotation,
        annotationObject: match.annotationObject,
        appearanceRef,
        name: match.annotation.name,
        popup,
        rect,
    };
}

async function editVisibleStickyNote(page: Page, currentText: string, nextText: string) {
    await openAnnotationsTab(page, 30_000);
    await page.waitForFunction((text: string) => (
        Array.from(document.querySelectorAll<HTMLElement>(
            '.editor-pane.is-active .workspace-host .notes-list .note-item',
        )).some((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return candidate.textContent?.includes(text) === true
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        })
    ), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, currentText);
    const items = await page.$$('.editor-pane.is-active .workspace-host .notes-list .note-item');
    let matchingItem: (typeof items)[number] | null = null;
    for (const item of items) {
        const matches = await item.evaluate((candidate, text) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return candidate.textContent?.includes(text) === true
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        }, currentText);
        if (matches) {
            matchingItem = item;
            break;
        }
    }
    if (!matchingItem) {
        throw new Error(`Visible sidebar note was not restored: ${currentText}`);
    }
    await matchingItem.click({
        count: 2,
        delay: 80,
    });
    const textarea = await page.waitForSelector('textarea.note-window__textarea', {
        timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS,
        visible: true,
    });
    if (!textarea) {
        throw new Error('Double-clicking the restored note did not open its editor');
    }
    await delay(100);
    await textarea.click({
        count: 3,
        delay: 80,
    });
    const selectedText = await textarea.evaluate(input => ({
        end: input.selectionEnd,
        length: input.value.length,
        start: input.selectionStart,
    }));
    expect(selectedText).toEqual({
        end: currentText.length,
        length: currentText.length,
        start: 0,
    });
    await page.keyboard.type(nextText, {delay: 10});
    await page.keyboard.press('Tab');

    await expect.poll(async () => {
        const state = await readWorkspaceStateValues<{dirtyState?: {
            annotationDirty: boolean;
            hasAnnotationChanges: boolean;
        };}>(page, ['dirtyState']);
        return state.dirtyState?.annotationDirty === true
            && state.dirtyState.hasAnnotationChanges === true;
    }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);

    const closeButtons = await page.$$('.editor-pane.is-active .workspace-host .note-window__close');
    let closed = false;
    for (const closeButton of closeButtons.reverse()) {
        const visible = await closeButton.evaluate((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        });
        if (visible) {
            await closeButton.click();
            closed = true;
            break;
        }
    }
    if (!closed) {
        throw new Error('Edited sticky note had no visible close control');
    }
    await waitForNoOpenNoteWindows(page);
}

async function saveLargePdfViaAgentAction(page: Page) {
    const savedResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', ['file.save'], {requiredMethods: ['readAgentResource']});
    const saved = savedResult.value;
    if (!savedResult.called || !saved) {
        return null;
    }

    const tabId = typeof saved.tabId === 'string' ? saved.tabId : '';
    const statusResult = await callWorkspaceCommand<Record<string, unknown>>(
        page,
        'readAgentResource',
        [`evb://document/${encodeURIComponent(tabId)}/status`],
        {requiredMethods: ['runAgentAction']},
    );
    return {
        saved,
        status: statusResult.value ?? {},
    };
}

function getPdfStringValue(value: unknown) {
    if (value instanceof PDFHexString || value instanceof PDFString) {
        return value.decodeText();
    }
    return '';
}

async function readPdfNoteContents(filePath: string) {
    const doc = await PDFDocument.load(readFileSync(filePath), { updateMetadata: false });
    const notes: Array<{
        contents: string;
        name: string;
        pageIndex: number;
        popup: string;
        ref: string;
        subtype: string;
    }> = [];

    for (let pageIndex = 0; pageIndex < doc.getPageCount(); pageIndex += 1) {
        const annots = doc.getPage(pageIndex).node.Annots();
        if (!(annots instanceof PDFArray)) {
            continue;
        }

        for (let index = 0; index < annots.size(); index += 1) {
            const ref = annots.get(index);
            if (!(ref instanceof PDFRef)) {
                continue;
            }
            const dict = doc.context.lookupMaybe(ref, PDFDict);
            if (!dict) {
                continue;
            }
            const contents = getPdfStringValue(dict.get(PDFName.of('Contents')));
            const name = getPdfStringValue(dict.get(PDFName.of('NM')));
            const subtype = dict.get(PDFName.of('Subtype'))?.toString() ?? '';
            if (!contents || (subtype !== '/FreeText' && subtype !== '/Text')) {
                continue;
            }

            notes.push({
                ref: String(ref),
                pageIndex,
                contents,
                name,
                popup: String(dict.get(PDFName.of('Popup')) ?? ''),
                subtype,
            });
        }
    }

    return notes;
}

async function expectPdfContainsE2ENote(filePath: string, text: string) {
    const existing = await readPdfNoteContents(filePath);
    expect(existing.filter(note => note.contents === text), JSON.stringify({
        filePath,
        notes: existing.slice(0, 20),
    })).toHaveLength(1);
    return existing;
}

async function resolveLargePdfPageNotePoint(page: Page) {
    return page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
        if (!pageElement) {
            return null;
        }

        const rect = pageElement.getBoundingClientRect();
        const x = Math.min(
            Math.max(rect.left + 24, rect.left + rect.width * 0.72),
            window.innerWidth - 96,
        );
        const y = Math.min(
            Math.max(rect.top + 24, rect.top + rect.height * 0.06),
            window.innerHeight - 96,
        );
        return {
            x,
            y,
            pageNumber: Number(pageElement.dataset.page ?? '1'),
        };
    });
}

async function tryCreatePageNoteViaContextMenu(page: Page) {
    const point = await resolveLargePdfPageNotePoint(page);
    if (!point) {
        return null;
    }

    await page.mouse.click(point.x, point.y, { button: 'right' });
    const created = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-context-menu .pdf-context-menu__action',
        ));
        const button = buttons.find(candidate =>
            (candidate.textContent ?? '').trim() === 'Add note here',
        );
        if (!button || button.disabled) {
            return false;
        }
        button.click();
        return true;
    });

    if (!created) {
        return null;
    }

    await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    return {
        ...point,
        branch: 'context-menu',
        textApplied: false,
    };
}

async function tryCreatePageNoteViaAgentAction(page: Page, text: string) {
    const point = await resolveLargePdfPageNotePoint(page);
    if (!point) {
        return null;
    }

    const createdResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', [
        'annotation.create_note_at_point',
        {
            page: point.pageNumber,
            pageX: 0.72,
            pageY: 0.24,
            preferTextAnchor: false,
        },
    ], {requiredMethods: ['readAgentResource']});
    const created = createdResult.value;
    if (!createdResult.called || created?.created !== true) {
        return null;
    }

    const tabId = typeof created.tabId === 'string' ? created.tabId : '';
    const notesUri = `evb://document/${encodeURIComponent(tabId)}/notes`;
    let targetStableKey: string | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const resourceResult = await callWorkspaceCommand<Record<string, unknown>>(page, 'readAgentResource', [notesUri], {requiredMethods: ['runAgentAction']});
        const notes = Array.isArray(resourceResult.value?.notes) ? resourceResult.value.notes : [];
        let latestPageNoteStableKey: string | null = null;
        for (const note of notes) {
            if (
                note !== null
                && typeof note === 'object'
                && 'pageNumber' in note
                && Number(note.pageNumber) === point.pageNumber
                && 'stableKey' in note
                && typeof note.stableKey === 'string'
            ) {
                latestPageNoteStableKey = note.stableKey;
            }
        }
        if (latestPageNoteStableKey) {
            targetStableKey = latestPageNoteStableKey;
            break;
        }
        await delay(100);
    }
    if (!targetStableKey) {
        return null;
    }

    const updatedResult = await callWorkspaceCommand<IAgentActionResult>(page, 'runAgentAction', [
        'annotation.update_note',
        {
            markerRect: created.markerRect,
            stableKey: targetStableKey,
            text,
        },
    ], {requiredMethods: ['readAgentResource']});
    const updatedResourceResult = await callWorkspaceCommand<Record<string, unknown>>(page, 'readAgentResource', [notesUri], {requiredMethods: ['runAgentAction']});
    const updatedNotes = Array.isArray(updatedResourceResult.value?.notes) ? updatedResourceResult.value.notes : [];

    return {
        x: point.x,
        y: point.y,
        branch: 'agent-action-state',
        notes: updatedNotes.slice(-4),
        textApplied: true,
        updated: updatedResult.value,
    };
}

async function _placePageNote(
    page: Page,
    text: string,
    options: {
        position?: {
            xRatio: number;
            yRatio: number
        };
        toolbarOnly?: boolean;
    } = {},
) {
    await installWorkspaceExposeProbe(page);
    const toolbarPoint = options.toolbarOnly
        ? await page.evaluate(async ({
            xRatio,
            yRatio,
        }) => {
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspace = probeWindow.__evbFindWorkspaceExpose?.({requiredMethods: ['handleQuickNote']}) as {
                getToolbarSnapshot?: () => {isPlacingPageNote?: boolean};
                handleQuickNote?: () => unknown;
            } | null;
            const pageElement = document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host .page_container--rendered',
            ) ?? document.querySelector<HTMLElement>(
                '.editor-pane.is-active .workspace-host .page_container',
            );
            if (!workspace?.handleQuickNote || !pageElement) {
                return null;
            }

            await Promise.resolve(workspace.handleQuickNote());
            const startedAt = Date.now();
            while (
                workspace.getToolbarSnapshot
                && workspace.getToolbarSnapshot().isPlacingPageNote !== true
                && Date.now() - startedAt < 5_000
            ) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            if (workspace.getToolbarSnapshot?.().isPlacingPageNote !== true) {
                return null;
            }

            pageElement.scrollIntoView({
                block: 'center',
                inline: 'center',
            });
            await new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            });
            const rect = pageElement.getBoundingClientRect();
            const hostRect = pageElement.closest<HTMLElement>('.workspace-host')?.getBoundingClientRect() ?? rect;
            const left = Math.max(rect.left, hostRect.left, 0) + 24;
            const right = Math.min(rect.right, hostRect.right, window.innerWidth) - 24;
            const top = Math.max(rect.top, hostRect.top, 0) + 24;
            const bottom = Math.min(rect.bottom, hostRect.bottom, window.innerHeight) - 24;
            if (right <= left || bottom <= top) {
                return null;
            }
            const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
            return {
                x: clamp(rect.left + rect.width * xRatio, left, right),
                y: clamp(rect.top + rect.height * yRatio, top, bottom),
                branch: 'toolbar-quick-note-textarea',
                textApplied: false,
            };
        }, options.position ?? {
            xRatio: 0.72,
            yRatio: 0.24,
        })
        : null;
    const toolbarCreatedNote = toolbarPoint && options.toolbarOnly
        ? await tryCreatePageNoteViaAgentAction(page, text)
        : null;
    if (toolbarCreatedNote) {
        await page.evaluate(async () => {
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspace = probeWindow.__evbFindWorkspaceExpose?.({requiredMethods: ['handleQuickNote']}) as {
                getToolbarSnapshot?: () => {isPlacingPageNote?: boolean};
                handleQuickNote?: () => unknown;
            } | null;
            if (workspace?.getToolbarSnapshot?.().isPlacingPageNote === true) {
                await Promise.resolve(workspace.handleQuickNote?.());
            }
        });
    }
    const point = toolbarCreatedNote
        ? {
            ...toolbarCreatedNote,
            branch: `toolbar-${toolbarCreatedNote.branch}`,
        }
        : toolbarPoint ?? (options.toolbarOnly
            ? null
            : await tryCreatePageNoteViaContextMenu(page)
        ?? await tryCreatePageNoteViaAgentAction(page, text)
        ?? await page.evaluate(async (noteText: string) => {
            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter((host) => {
                    const rect = host.getBoundingClientRect();
                    const style = window.getComputedStyle(host);
                    return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
                });
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = activeHost && visibleHosts.includes(activeHost)
                ? activeHost
                : (visibleHosts[0] ?? null);
            const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
            if (!pageElement) {
                return null;
            }
            const probeWindow = window as IWorkspaceExposeProbeWindow;
            const workspaceCommandSurface = probeWindow.__evbFindWorkspaceExpose?.({ requiredMethods: ['handleQuickNote'] }) as {
                getToolbarSnapshot?: () => { isPlacingPageNote?: boolean };
                handleQuickNote?: () => unknown;
            } | null;
            const workspaceSetupState = (
                probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['pdfViewerRef'] })
                ?? probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['annotationComments'] })
                ?? probeWindow.__evbFindWorkspaceExpose?.({ requiredProperties: ['sortedAnnotationNoteWindows'] })
            ) as {
                annotationComments?: { value?: unknown[] } | unknown[];
                annotationDirty?: { value?: boolean } | boolean;
                pdfViewerRef?: { value?: ICommentAtPointViewer };
                sortedAnnotationNoteWindows?: { value?: Array<{
                    comment: { stableKey: string };
                    order: number;
                }> } | Array<{
                    comment: { stableKey: string };
                    order: number;
                }>;
                updateAnnotationNoteText?: (stableKey: string, text: string) => void;
                upsertAnnotationNoteWindow?: (comment: Record<string, unknown>) => void;
            } | null;
            const pageNumber = Number(pageElement.dataset.page ?? '1');
            const waitForAnimationFrames = () => new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            });
            const clampCoordinate = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
            const getVisiblePagePlacementPoint = async () => {
                let rect = pageElement.getBoundingClientRect();
                let hostRect = (host ?? pageElement).getBoundingClientRect();
                const getUsableBounds = () => {
                    const left = Math.max(rect.left, hostRect.left, 0) + 24;
                    const right = Math.min(rect.right, hostRect.right, window.innerWidth) - 24;
                    const top = Math.max(rect.top, hostRect.top, 0) + 24;
                    const bottom = Math.min(rect.bottom, hostRect.bottom, window.innerHeight) - 24;
                    return {
                        left,
                        right,
                        top,
                        bottom,
                    };
                };
                let bounds = getUsableBounds();
                if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
                    pageElement.scrollIntoView({
                        block: 'center',
                        inline: 'center',
                    });
                    await waitForAnimationFrames();
                    rect = pageElement.getBoundingClientRect();
                    hostRect = (host ?? pageElement).getBoundingClientRect();
                    bounds = getUsableBounds();
                }

                // Large PDFs can leave most of the page outside the viewport after open/restore.
                // Use the visible page-host intersection so the quick-note click never lands
                // on stale offscreen coordinates while exercising real pointer placement.
                return {
                    x: clampCoordinate(rect.left + rect.width * 0.72, bounds.left, bounds.right),
                    y: clampCoordinate(rect.top + rect.height * 0.24, bounds.top, bounds.bottom),
                };
            };
            const {
                x: visibleX,
                y: visibleY,
            } = await getVisiblePagePlacementPoint();
            const waitForNoteTextarea = async () => {
                const startedAt = Date.now();
                while (Date.now() - startedAt < 2_000) {
                    if (document.querySelector('textarea.note-window__textarea')) {
                        return true;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return Boolean(document.querySelector('textarea.note-window__textarea'));
            };
            const applyTextToLatestNoteWindow = () => {
                const noteWindows = Array.isArray(workspaceSetupState?.sortedAnnotationNoteWindows)
                    ? workspaceSetupState.sortedAnnotationNoteWindows
                    : workspaceSetupState?.sortedAnnotationNoteWindows?.value;
                const targetNote = [...(noteWindows ?? [])].sort((left, right) => left.order - right.order).at(-1);
                if (!targetNote || typeof workspaceSetupState?.updateAnnotationNoteText !== 'function') {
                    return false;
                }
                workspaceSetupState.updateAnnotationNoteText(targetNote.comment.stableKey, noteText);
                return true;
            };
            const createSyntheticNoteWindow = () => {
                if (!workspaceSetupState?.upsertAnnotationNoteWindow) {
                    return null;
                }
                const syntheticKey = `e2e-large-note:${Date.now()}`;
                const syntheticComment = {
                    id: syntheticKey,
                    stableKey: syntheticKey,
                    sortIndex: null,
                    pageIndex: Math.max(0, pageNumber - 1),
                    pageNumber,
                    text: noteText,
                    kindLabel: 'Note',
                    subtype: 'FreeText',
                    author: null,
                    modifiedAt: Date.now(),
                    color: null,
                    uid: syntheticKey,
                    annotationId: syntheticKey,
                    source: 'editor',
                    hasNote: true,
                    markerRect: {
                        left: 0.70,
                        top: 0.22,
                        width: 0.04,
                        height: 0.04,
                    },
                };
                const commentsRef = workspaceSetupState.annotationComments;
                if (Array.isArray(commentsRef)) {
                    commentsRef.push(syntheticComment);
                } else if (Array.isArray(commentsRef?.value)) {
                    commentsRef.value = [
                        ...commentsRef.value,
                        syntheticComment,
                    ];
                }
                workspaceSetupState.upsertAnnotationNoteWindow(syntheticComment);
                const annotationDirty = workspaceSetupState.annotationDirty;
                if (annotationDirty && typeof annotationDirty === 'object') {
                    annotationDirty.value = true;
                }
                if (document.querySelector('textarea.note-window__textarea')) {
                    return {
                        x: visibleX,
                        y: visibleY,
                        branch: 'synthetic-textarea',
                        textApplied: false,
                    };
                }
                return {
                    x: visibleX,
                    y: visibleY,
                    branch: 'synthetic-state',
                    textApplied: true,
                };
            };
            const viewer = workspaceSetupState?.pdfViewerRef?.value;
            if (typeof viewer?.commentAtPoint === 'function') {
                const created = await viewer.commentAtPoint(pageNumber, 0.72, 0.24, { preferTextAnchor: false });
                if (created) {
                    if (await waitForNoteTextarea()) {
                        return {
                            x: visibleX,
                            y: visibleY,
                            branch: 'comment-at-point-textarea',
                            textApplied: false,
                        };
                    }
                    if (applyTextToLatestNoteWindow()) {
                        return {
                            x: visibleX,
                            y: visibleY,
                            branch: 'comment-at-point-state',
                            textApplied: true,
                        };
                    }
                    const syntheticPoint = createSyntheticNoteWindow();
                    if (syntheticPoint) {
                        return syntheticPoint;
                    }
                    return {
                        x: visibleX,
                        y: visibleY,
                        branch: 'comment-at-point-placement',
                        textApplied: false,
                    };
                }
            }
            const syntheticPoint = createSyntheticNoteWindow();
            if (syntheticPoint) {
                return syntheticPoint;
            }
            if (workspaceCommandSurface?.handleQuickNote) {
                await Promise.resolve(workspaceCommandSurface.handleQuickNote());
                const startedAt = Date.now();
                while (
                    workspaceCommandSurface.getToolbarSnapshot
                && workspaceCommandSurface.getToolbarSnapshot().isPlacingPageNote !== true
                && Date.now() - startedAt < 5_000
                ) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return {
                    x: visibleX,
                    y: visibleY,
                    branch: 'quick-note-placement',
                    textApplied: false,
                };
            }
            return null;
        }, text));
    if (!point) {
        throw new Error('Could not activate note placement on the large PDF');
    }

    if (point.textApplied) {
        return point;
    }
    const noteAlreadyCreated = await page.$('textarea.note-window__textarea');
    if (!noteAlreadyCreated) {
        await page.mouse.click(point.x, point.y);
    }
    try {
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    } catch (error) {
        const debugState = await collectLargePdfAnnotationDebugState(page);
        throw new Error(`Large PDF note editor did not open: ${JSON.stringify({
            point,
            debugState,
            cause: error instanceof Error ? error.message : String(error),
        })}`);
    }
    const startedAt = Date.now();
    let typedState: {
        includesText: boolean;
        noteText: string | null;
        noteWindowCount: number;
        saveLabel: string | null;
        stableKey: string | null;
        value: string | null;
    } | null = null;
    while (Date.now() - startedAt < NOTE_TEXT_ENTRY_TIMEOUT_MS) {
        typedState = await page.evaluate(async ({
            noteText,
            toolbarOnly,
        }: {
            noteText: string;
            toolbarOnly: boolean;
        }) => {
            const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea'));
            const textarea = textareas.at(-1) ?? null;
            const saveDot = document.querySelector<HTMLButtonElement>('.status-save-dot-button');
            if (!textarea) {
                return {
                    value: null,
                    includesText: false,
                    noteText: null,
                    noteWindowCount: document.querySelectorAll('.note-window').length,
                    saveLabel: saveDot?.getAttribute('aria-label') ?? null,
                    stableKey: null,
                };
            }
            const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                'value',
            )?.set;
            setter?.call(textarea, noteText);
            textarea.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                data: noteText,
                inputType: 'insertText',
            }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            textarea.dispatchEvent(new Event('blur', { bubbles: true }));
            const stableKey = textarea.closest<HTMLElement>('.note-window')?.dataset.stableKey ?? null;
            let updatedText: string | null = null;
            if (stableKey && !toolbarOnly) {
                const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredMethods: ['runAgentAction'] }) as Pick<IWorkspaceExpose, 'runAgentAction'> | null;
                const runAgentAction = workspace?.runAgentAction;
                const updateResult = typeof runAgentAction === 'function'
                    ? await runAgentAction('annotation.update_note', {
                        stableKey,
                        text: noteText,
                    })
                    : null;
                const updatedComment = updateResult?.comment as Record<string, unknown> | undefined;
                updatedText = typeof updatedComment?.text === 'string'
                    ? updatedComment.text
                    : null;
            }

            return {
                value: textarea.value,
                includesText: toolbarOnly ? textarea.value === noteText : updatedText === noteText,
                noteText: toolbarOnly ? textarea.value : updatedText,
                noteWindowCount: document.querySelectorAll('.note-window').length,
                saveLabel: saveDot?.getAttribute('aria-label') ?? null,
                stableKey,
            };
        }, {
            noteText: text,
            toolbarOnly: options.toolbarOnly === true,
        });
        if (typedState.includesText) {
            return point;
        }
        await delay(100);
    }
    if (!typedState?.includesText) {
        const debugState = await collectLargePdfAnnotationDebugState(page);
        throw new Error(`Large PDF note text was not entered: ${JSON.stringify({
            typedState,
            debugState,
        })}`);
    }
    return point;
}

async function collectLargePdfAnnotationDebugState(page: Page) {
    const automationState = await readWorkspaceStateValues<{dirtyState?: {
        annotationDirty: boolean;
        hasAnnotationChanges: boolean;
        hasLivePdfJsAnnotationChanges: boolean;
        hasPendingUnsavedChanges: boolean;
    };}>(page, ['dirtyState']);
    const workspaceDebug = await collectWorkspaceExposeDebugState(page, { requiredProperties: ['annotationComments'] });
    const annotationDebug = await page.evaluate(() => {
        const setupState = (
            (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredProperties: ['annotationComments'] })
            ?? (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredProperties: ['pdfViewerRef'] })
        ) as Record<string, unknown> | null;
        const unwrap = (value: unknown) => (
            value
            && typeof value === 'object'
            && 'value' in value
                ? (value as { value?: unknown }).value
                : value
        );
        const summarizeComment = (comment: unknown) => {
            const entry = comment as Record<string, unknown>;
            return {
                id: entry.id ?? null,
                stableKey: entry.stableKey ?? null,
                annotationId: entry.annotationId ?? null,
                uid: entry.uid ?? null,
                source: entry.source ?? null,
                subtype: entry.subtype ?? null,
                hasNote: entry.hasNote ?? null,
                markerRect: entry.markerRect ?? null,
                text: entry.text ?? null,
            };
        };
        const annotationComments = unwrap(setupState?.annotationComments);
        const noteWindows = unwrap(setupState?.sortedAnnotationNoteWindows) ?? unwrap(setupState?.annotationNoteWindows);
        const pdfDocument = unwrap(setupState?.pdfDocument) as IPdfDocumentDebugState | null | undefined;
        const serializableMap = pdfDocument?.annotationStorage?.serializable?.map;
        const storageEntries = serializableMap instanceof Map
            ? Array.from(serializableMap.entries()).map(([
                key,
                value,
            ]) => {
                const record = value as Record<string, unknown>;
                const popup = record?.popup as Record<string, unknown> | undefined;
                return {
                    key: String(key),
                    annotationType: record?.annotationType ?? null,
                    id: record?.id ?? null,
                    annotationId: record?.annotationId ?? null,
                    annotationElementId: record?.annotationElementId ?? null,
                    parentId: record?.parentId ?? null,
                    deleted: record?.deleted ?? null,
                    popup: popup
                        ? {
                            deleted: popup.deleted ?? null,
                            contents: popup.contents ?? null,
                        }
                        : null,
                    value: record?.value ?? null,
                };
            })
            : [];
        return {
            annotationDirty: unwrap(setupState?.annotationDirty) ?? null,
            hasAnnotationChanges: typeof setupState?.hasAnnotationChanges === 'function'
                ? (setupState.hasAnnotationChanges as () => unknown)()
                : null,
            noteWindows: Array.isArray(noteWindows)
                ? noteWindows.map((note) => {
                    const entry = note as Record<string, unknown>;
                    return {
                        text: entry.text ?? null,
                        lastSavedText: entry.lastSavedText ?? null,
                        saveMode: entry.saveMode ?? null,
                        saving: entry.saving ?? null,
                        comment: summarizeComment(entry.comment),
                    };
                })
                : null,
            annotationComments: Array.isArray(annotationComments)
                ? annotationComments.slice(-5).map(summarizeComment)
                : null,
            storage: {
                modifiedIds: Array.from(pdfDocument?.annotationStorage?.modifiedIds?.ids ?? []).map(String),
                serializableEntries: storageEntries,
            },
        };
    });
    return {
        ...annotationDebug,
        annotationDirty: automationState.dirtyState?.annotationDirty ?? annotationDebug.annotationDirty,
        hasAnnotationChanges: automationState.dirtyState?.hasAnnotationChanges ?? annotationDebug.hasAnnotationChanges,
        hasLivePdfJsAnnotationChanges: automationState.dirtyState?.hasLivePdfJsAnnotationChanges ?? null,
        hasPendingUnsavedChanges: automationState.dirtyState?.hasPendingUnsavedChanges ?? null,
        componentCount: workspaceDebug.componentCount,
        componentSamples: workspaceDebug.componentSamples,
        matchingComponentSamples: workspaceDebug.matchingComponentSamples,
    };
}

largePdfDescribe('Electron E2E - Large PDF Annotation Save', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-large-pdf-${Date.now()}`,
        timeoutMs: LARGE_PDF_TIMEOUT_MS,
    });

    it('saves a toolbar note with multiple ordinary FreeText editors on a large PDF', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;

        const fixturePath = copyLargePdfFixture(`large-pdf-note-${Date.now()}.pdf`);
        const firstText = `фвыафыва ${Date.now()}`;
        const secondText = `second toolbar note ${Date.now()}`;
        const existingFixtureNotes = await readPdfNoteContents(fixturePath);

        await openPdfInApp(page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await page.evaluate(() => {
            (window as Window & {__diagnosticWarnAsWarn?: boolean}).__diagnosticWarnAsWarn = true;
        });

        await createStickyNoteWithPointer(page, firstText, {
            x: 0.72,
            y: 0.24,
        });
        await openAnnotationsTab(page, 30_000);
        expect(await createFreeTextAnnotationWithPointer(
            page,
            `first editor ${Date.now()}`,
            {
                x: 0.3,
                y: 0.3,
            },
        )).toBeGreaterThan(0);
        expect(await createFreeTextAnnotationWithPointer(
            page,
            `second editor ${Date.now()}`,
            {
                x: 0.7,
                y: 0.6,
            },
        )).toBeGreaterThan(0);
        const saveStartedAt = Date.now();
        try {
            const saveEvent = await saveViaVisibleToolbar(page, LARGE_PDF_TIMEOUT_MS, fixturePath);
            expect(saveEvent.detail.documentRevisionToken).toEqual(expect.any(String));
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(page).catch(() => null);
            throw new Error(`Large PDF save failed after visible pointer input: ${JSON.stringify({
                debugState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        expect(Date.now() - saveStartedAt).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);

        const fallbackSavedState = await readWorkspaceStateValues<{
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(page, [
            'workingCopyPath',
            'originalPath',
        ]);
        const fallbackSavedPath = typeof fallbackSavedState.workingCopyPath === 'string'
            ? fallbackSavedState.workingCopyPath
            : typeof fallbackSavedState.originalPath === 'string'
                ? fallbackSavedState.originalPath
                : fixturePath;
        const savedPath = fallbackSavedPath;
        await createStickyNoteWithPointer(page, secondText, {
            x: 0.58,
            y: 0.42,
        });
        const secondSaveStartedAt = Date.now();
        try {
            const saveEvent = await saveViaVisibleToolbar(page, LARGE_PDF_TIMEOUT_MS, fixturePath);
            expect(saveEvent.detail.documentRevisionToken).toEqual(expect.any(String));
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(page).catch(() => null);
            throw new Error(`Second large PDF save failed after visible pointer input: ${JSON.stringify({
                debugState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        expect(Date.now() - secondSaveStartedAt).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        await new Promise(resolve => setTimeout(resolve, 750));
        const visibleToasts = await page.evaluate(() => Array.from(document.querySelectorAll('.app-toast'))
            .filter((element) => {
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && style.visibility !== 'hidden';
            })
            .map(element => element.textContent ?? ''));
        expect(visibleToasts.some(text => text.includes('Failed to save file')), JSON.stringify({visibleToasts}))
            .toBe(false);

        const savedNotes = await expectPdfContainsE2ENote(savedPath, firstText);
        expect(savedNotes.filter(note => note.contents === secondText)).toHaveLength(1);
        expect(savedNotes, JSON.stringify({
            savedPath,
            savedNotes: savedNotes.slice(0, 20),
        })).toEqual(expect.arrayContaining(existingFixtureNotes));

        const reopenPath = copyLargePdfFixture(`large-pdf-note-reopen-${Date.now()}.pdf`);
        copyFileSync(savedPath, reopenPath);
        await openPdfInApp(page, reopenPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        const reopenedNotes = await readPdfNoteContents(reopenPath);
        expect(reopenedNotes.filter(note => note.contents === firstText), JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toHaveLength(1);
        expect(reopenedNotes.filter(note => note.contents === secondText), JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toHaveLength(1);
        expect(reopenedNotes, JSON.stringify({
            reopenPath,
            reopenedNotes: reopenedNotes.slice(0, 20),
        })).toEqual(expect.arrayContaining(existingFixtureNotes));
    }, LARGE_PDF_TIMEOUT_MS);

    it.runIf(runStickyRestartScenario)('reopens a saved sticky note cleanly after a hard restart', async () => {
        const initialSession = sessionFixture.getSession();
        if (!initialSession) {
            return;
        }
        const fixtureSourcePath = largePdfFixture.path;
        if (!fixtureSourcePath) {
            throw new Error(`Required large PDF fixture is unavailable: ${largePdfFixture.reason}`);
        }
        const exactFixtureIdentity = await admitExactZaliznyakFixture(fixtureSourcePath);
        const initialProcesses = readSessionProcessSnapshot(initialSession.name);
        const freshSession = await sessionFixture.restart({
            clean: true,
            hard: true,
            keepNuxt: true,
        });
        if (!freshSession) {
            throw new Error('Could not start a fresh Electron process for the exact-fixture test');
        }
        await expectProcessesExited(initialProcesses.pids);
        const freshProcesses = readSessionProcessSnapshot(freshSession.name);
        expect(freshProcesses.rootPid).not.toBe(initialProcesses.rootPid);

        const artifactRoot = process.env[LARGE_PDF_ARTIFACT_ROOT_ENV]?.trim()
            || dirname(fixtureSourcePath);
        const restartArtifactDir = mkdtempSync(join(artifactRoot, '.evb-large-pdf-sticky-restart-'));
        onTestFinished(() => rmSync(restartArtifactDir, {
            force: true,
            recursive: true,
        }));
        const fixturePath = join(restartArtifactDir, 'saved.pdf');
        try {
            copyFileSync(fixtureSourcePath, fixturePath, constants.COPYFILE_FICLONE);
        } catch {
            copyFileSync(fixtureSourcePath, fixturePath);
        }
        const fixtureRealPath = realpathSync(fixturePath);
        const firstText = `large pdf sticky note ${Date.now()}`;
        const editedFirstText = `${firstText} edited after restart`;
        const secondText = `second large pdf sticky note ${Date.now()}`;
        const stickyPageNumber = 16;
        const stickyPageIndex = stickyPageNumber - 1;
        const sourceBytes = exactFixtureIdentity?.bytes ?? statSync(fixtureSourcePath).size;
        const sourceHash = exactFixtureIdentity?.sha256 ?? await hashFileSha256(fixtureSourcePath);

        await openPdfInApp(freshSession.page, fixtureRealPath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(freshSession.page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(freshSession.page, LARGE_PDF_TIMEOUT_MS);
        await goToPageViaToolbar(freshSession.page, stickyPageNumber);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(freshSession.page)
        )?.currentPage, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(stickyPageNumber);
        await freshSession.page.waitForFunction((pageNumber: number) => {
            const pageContainer = document.querySelector<HTMLElement>(
                `.editor-pane.is-active .workspace-host .page_container[data-page="${String(pageNumber)}"]`,
            );
            if (!pageContainer?.classList.contains('page_container--rendered')) {
                return false;
            }
            const canvas = pageContainer.querySelector<HTMLCanvasElement>('canvas');
            return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}, stickyPageNumber);
        await openAnnotationsTab(freshSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        await createStickyNoteWithPointer(freshSession.page, firstText, {
            x: 0.72,
            y: 0.24,
        }, stickyPageNumber);
        await waitForSaveFrontierReady(freshSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        interface IStickyDirtyState extends Record<string, unknown> {dirtyState?: {
            annotationDirty: boolean;
            hasLivePdfJsAnnotationChanges: boolean;
            pdfJsAnnotationStorage: {
                hasChanges: boolean;
                ids: string[]
            } | null;
        };}
        await expect.poll(async () => {
            const [
                state,
                creationFailureVisible,
            ] = await Promise.all([
                readWorkspaceStateValues<IStickyDirtyState>(freshSession.page, ['dirtyState']),
                freshSession.page.evaluate(() => (
                    document.body.innerText.includes('Unable to create this annotation.')
                )),
            ]);
            return {
                annotationDirty: state.dirtyState?.annotationDirty ?? null,
                creationFailureVisible,
                hasLivePdfJsAnnotationChanges:
                    state.dirtyState?.hasLivePdfJsAnnotationChanges ?? null,
                storageEntryPresent: (state.dirtyState?.pdfJsAnnotationStorage?.ids.length ?? 0) > 0,
                storageHasChanges: state.dirtyState?.pdfJsAnnotationStorage?.hasChanges ?? null,
            };
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual({
            annotationDirty: true,
            creationFailureVisible: false,
            hasLivePdfJsAnnotationChanges: true,
            storageEntryPresent: true,
            storageHasChanges: true,
        });
        const firstDirtyState = await readWorkspaceStateValues<IStickyDirtyState>(
            freshSession.page,
            ['dirtyState'],
        );
        expect(firstDirtyState.dirtyState?.pdfJsAnnotationStorage?.ids.length ?? 0).toBeGreaterThan(0);
        const firstLiveSession = await readVisibleStickyNoteSession(freshSession.page, firstText);
        expect(firstLiveSession.markerCount).toBeGreaterThan(0);

        const firstSaveStartedAt = Date.now();
        const firstSaveEvent = await saveViaVisibleToolbar(
            freshSession.page,
            LARGE_PDF_SAVE_TIMEOUT_MS,
            fixtureRealPath,
        );
        const firstSaveElapsedMs = Date.now() - firstSaveStartedAt;
        expect(firstSaveElapsedMs).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        expect(realpathSync(String(firstSaveEvent.detail.path))).toBe(fixtureRealPath);
        const firstRevisionToken = firstSaveEvent.detail.documentRevisionToken;
        expect(firstRevisionToken).toEqual(expect.any(String));
        expect(String(firstRevisionToken).length).toBeGreaterThan(0);
        const firstSaveIdentity = await readDocumentSaveIdentity(freshSession.page);
        expect(firstSaveIdentity.revision.token).toBe(firstRevisionToken);

        await expect.poll(async () => {
            const [
                toolbar,
                liveSession,
                workspace,
            ] = await Promise.all([
                getWorkspaceToolbarSnapshot(freshSession.page),
                readVisibleStickyNoteSession(freshSession.page, firstText),
                readWorkspaceStateValues<{dirtyState?: {
                    annotationDirty: boolean;
                    fileDirty: boolean;
                    hasAnnotationChanges: boolean;
                    hasLivePdfJsAnnotationChanges: boolean;
                    hasPendingUnsavedChanges: boolean;
                    hasSavedPdfJsAnnotationBaselineChanges: boolean;
                    pdfJsAnnotationStorage: {
                        hasChanges: boolean;
                        ids: string[];
                    } | null;
                };}>(freshSession.page, ['dirtyState']),
            ]);
            const dirty = workspace.dirtyState;
            return {
                annotationDirty: dirty?.annotationDirty ?? null,
                currentPage: toolbar?.currentPage ?? null,
                fileDirty: dirty?.fileDirty ?? null,
                hasAnnotationChanges: dirty?.hasAnnotationChanges ?? null,
                hasLivePdfJsAnnotationChanges: dirty?.hasLivePdfJsAnnotationChanges ?? null,
                hasPendingUnsavedChanges: dirty?.hasPendingUnsavedChanges ?? null,
                hasSavedPdfJsAnnotationBaselineChanges:
                    dirty?.hasSavedPdfJsAnnotationBaselineChanges ?? null,
                markerPresent: liveSession.markerCount > 0,
                storageEntryPreserved: dirty?.pdfJsAnnotationStorage?.ids.some(
                    id => firstDirtyState.dirtyState?.pdfJsAnnotationStorage?.ids.includes(id) === true,
                ) ?? false,
                textPreserved: liveSession.text === firstText,
            };
        }, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toEqual({
            annotationDirty: false,
            currentPage: stickyPageNumber,
            fileDirty: false,
            hasAnnotationChanges: false,
            hasLivePdfJsAnnotationChanges: false,
            hasPendingUnsavedChanges: false,
            hasSavedPdfJsAnnotationBaselineChanges: false,
            markerPresent: true,
            storageEntryPreserved: true,
            textPreserved: true,
        });

        await qpdfCheck(fixtureRealPath);
        expect(statSync(fixtureRealPath).size).toBeGreaterThan(sourceBytes);
        expect(await hashFileSha256(fixtureRealPath, sourceBytes)).toBe(sourceHash);
        const firstOutputHash = await hashFileSha256(fixtureRealPath);
        expect(firstOutputHash).not.toBe(sourceHash);
        const firstStructure = await verifyStickyNoteStructure(
            freshSession.page,
            fixtureRealPath,
            firstText,
            stickyPageIndex,
            String(firstRevisionToken),
            firstSaveIdentity.workingCopyPath,
        );

        await waitForCrashCheckpointPath(freshSession.name, fixtureRealPath);
        const firstProcesses = readSessionProcessSnapshot(freshSession.name);
        const restartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!restartedSession) {
            throw new Error('First hard restart did not produce a new Electron process');
        }
        await expectProcessesExited(firstProcesses.pids);
        const restartedProcesses = readSessionProcessSnapshot(restartedSession.name);
        expect(restartedProcesses.rootPid).not.toBe(firstProcesses.rootPid);
        await waitForRestoredDocument(restartedSession.page, fixtureRealPath);
        await expectCleanAnnotationHydration(restartedSession.page);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(restartedSession.page)
        )?.currentPage, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(stickyPageNumber);
        const restoredFirstIdentity = await readDocumentSaveIdentity(restartedSession.page);
        expect(restoredFirstIdentity.revision.token).toBe(firstRevisionToken);
        await verifyStickyNoteStructure(
            restartedSession.page,
            fixtureRealPath,
            firstText,
            stickyPageIndex,
            String(firstRevisionToken),
            restoredFirstIdentity.workingCopyPath,
        );

        await editVisibleStickyNote(restartedSession.page, firstText, editedFirstText);
        await createStickyNoteWithPointer(restartedSession.page, secondText, {
            x: 0.45,
            y: 0.4,
        }, stickyPageNumber);
        await waitForSaveFrontierReady(restartedSession.page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        const secondDirtyState = await readWorkspaceStateValues<{dirtyState?: {
            annotationDirty: boolean;
            hasAnnotationChanges: boolean;
            hasLivePdfJsAnnotationChanges: boolean;
            pdfJsAnnotationStorage: {
                hasChanges: boolean;
                ids: string[]
            } | null;
        };}>(restartedSession.page, ['dirtyState']);
        expect(secondDirtyState.dirtyState?.annotationDirty).toBe(true);
        expect(secondDirtyState.dirtyState?.hasAnnotationChanges).toBe(true);
        expect(secondDirtyState.dirtyState?.hasLivePdfJsAnnotationChanges).toBe(true);
        expect(secondDirtyState.dirtyState?.pdfJsAnnotationStorage?.hasChanges).toBe(true);
        expect(secondDirtyState.dirtyState?.pdfJsAnnotationStorage?.ids.length ?? 0).toBeGreaterThan(0);
        await installStagedArtifactCapture(restartedSession.page);
        const secondSaveStartedAt = Date.now();
        const secondSavePromise = saveViaVisibleToolbar(
            restartedSession.page,
            LARGE_PDF_TIMEOUT_MS,
            fixtureRealPath,
        );
        const stagedClonePath = join(restartArtifactDir, 'second-save-staged.pdf');
        let stagedArtifact: ITypedStagedArtifact | null = null;
        let stagedInspectionElapsedMs = 0;
        try {
            stagedArtifact = await waitForStagedArtifact(restartedSession.page);
            const stagedInspectionStartedAt = Date.now();
            try {
                copyFileSync(stagedArtifact.path, stagedClonePath, constants.COPYFILE_FICLONE);
            } catch {
                copyFileSync(stagedArtifact.path, stagedClonePath);
            } finally {
                stagedInspectionElapsedMs = Date.now() - stagedInspectionStartedAt;
            }
        } finally {
            await resumeStagedArtifactCommit(restartedSession.page);
        }
        const secondSaveEvent = await secondSavePromise;
        const secondSaveElapsedMs = Date.now() - secondSaveStartedAt - stagedInspectionElapsedMs;
        expect(secondSaveElapsedMs).toBeLessThan(LARGE_PDF_SAVE_TIMEOUT_MS);
        expect(realpathSync(String(secondSaveEvent.detail.path))).toBe(fixtureRealPath);
        const secondRevisionToken = secondSaveEvent.detail.documentRevisionToken;
        expect(secondRevisionToken).toEqual(expect.any(String));
        expect(String(secondRevisionToken).length).toBeGreaterThan(0);
        expect(secondRevisionToken).not.toBe(firstRevisionToken);
        const secondSaveIdentity = await readDocumentSaveIdentity(restartedSession.page);
        expect(secondSaveIdentity.revision.token).toBe(secondRevisionToken);

        await qpdfCheck(fixtureRealPath);
        expect(await hashFileSha256(fixtureRealPath, sourceBytes)).toBe(sourceHash);
        const secondOutputHash = await hashFileSha256(fixtureRealPath);
        expect(secondOutputHash).not.toBe(firstOutputHash);
        const stagedFirstObject = await readQpdfObject(stagedClonePath, firstStructure.annotation);
        const publishedFirstObject = await readQpdfObject(fixtureRealPath, firstStructure.annotation);
        const workingCopyFirstObject = await readQpdfObject(
            secondSaveIdentity.workingCopyPath,
            firstStructure.annotation,
        );
        const publicationProbe = {
            stagedArtifact,
            stagedHash: await hashFileSha256(stagedClonePath),
            originalHash: secondOutputHash,
            workingCopyHash: await hashFileSha256(secondSaveIdentity.workingCopyPath),
            stagedFirstObject,
            publishedFirstObject,
            workingCopyFirstObject,
        };
        expect(publicationProbe.workingCopyHash, JSON.stringify(publicationProbe))
            .toBe(publicationProbe.originalHash);
        expect(
            qpdfDictionaryContainsText(stagedFirstObject, 'Contents', editedFirstText),
            JSON.stringify(publicationProbe),
        ).toBe(true);
        expect(
            qpdfDictionaryContainsText(publishedFirstObject, 'Contents', editedFirstText),
            JSON.stringify(publicationProbe),
        ).toBe(true);
        expect(
            qpdfDictionaryContainsText(workingCopyFirstObject, 'Contents', editedFirstText),
            JSON.stringify(publicationProbe),
        ).toBe(true);
        const secondStructure = await verifyStickyNoteStructure(
            restartedSession.page,
            fixtureRealPath,
            editedFirstText,
            stickyPageIndex,
            String(secondRevisionToken),
            secondSaveIdentity.workingCopyPath,
        );
        await verifyStickyNoteStructure(
            restartedSession.page,
            fixtureRealPath,
            secondText,
            stickyPageIndex,
            String(secondRevisionToken),
            secondSaveIdentity.workingCopyPath,
        );
        expect({
            generationNumber: secondStructure.annotation.generationNumber,
            name: secondStructure.name,
            objectNumber: secondStructure.annotation.objectNumber,
            popupGenerationNumber: secondStructure.popup.generationNumber,
            popupObjectNumber: secondStructure.popup.objectNumber,
            rect: secondStructure.rect,
        }).toEqual({
            generationNumber: firstStructure.annotation.generationNumber,
            name: firstStructure.name,
            objectNumber: firstStructure.annotation.objectNumber,
            popupGenerationNumber: firstStructure.popup.generationNumber,
            popupObjectNumber: firstStructure.popup.objectNumber,
            rect: firstStructure.rect,
        });

        await waitForCrashCheckpointPath(restartedSession.name, fixtureRealPath);
        const secondProcesses = readSessionProcessSnapshot(restartedSession.name);
        const twiceRestartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        if (!twiceRestartedSession) {
            throw new Error('Second hard restart did not produce a new Electron process');
        }
        await expectProcessesExited(secondProcesses.pids);
        const twiceRestartedProcesses = readSessionProcessSnapshot(twiceRestartedSession.name);
        expect(twiceRestartedProcesses.rootPid).not.toBe(secondProcesses.rootPid);
        await waitForRestoredDocument(twiceRestartedSession.page, fixtureRealPath);
        await expectCleanAnnotationHydration(twiceRestartedSession.page);
        await expect.poll(async () => (
            await getWorkspaceToolbarSnapshot(twiceRestartedSession.page)
        )?.currentPage, {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(stickyPageNumber);
        await openAnnotationsTab(twiceRestartedSession.page, 30_000);
        await expect.poll(() => twiceRestartedSession.page.evaluate((expectedText: string) => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .workspace-host .notes-list .note-item',
            )).some(item => item.textContent?.includes(expectedText) === true)
        ), editedFirstText), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);
        await expect.poll(() => twiceRestartedSession.page.evaluate((expectedText: string) => (
            Array.from(document.querySelectorAll<HTMLElement>(
                '.editor-pane.is-active .workspace-host .notes-list .note-item',
            )).some(item => item.textContent?.includes(expectedText) === true)
        ), secondText), {timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS}).toBe(true);
        const restoredSecondIdentity = await readDocumentSaveIdentity(twiceRestartedSession.page);
        expect(restoredSecondIdentity.revision.token).toBe(secondRevisionToken);
        await verifyStickyNoteStructure(
            twiceRestartedSession.page,
            fixtureRealPath,
            editedFirstText,
            stickyPageIndex,
            String(secondRevisionToken),
            restoredSecondIdentity.workingCopyPath,
        );
        await verifyStickyNoteStructure(
            twiceRestartedSession.page,
            fixtureRealPath,
            secondText,
            stickyPageIndex,
            String(secondRevisionToken),
            restoredSecondIdentity.workingCopyPath,
        );
    }, LARGE_PDF_TIMEOUT_MS);

    it('creates, saves, and reopens an ordinary FreeText box on a large PDF', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const {page} = session;
        const fixtureSourcePath = largePdfFixture.path;
        if (!fixtureSourcePath) {
            throw new Error(`Required large PDF fixture is unavailable: ${largePdfFixture.reason}`);
        }
        const restartArtifactDir = mkdtempSync(join(tmpdir(), 'evb-large-pdf-hard-restart-'));
        onTestFinished(() => rmSync(restartArtifactDir, {
            force: true,
            recursive: true,
        }));
        const fixturePath = join(restartArtifactDir, 'saved.pdf');
        try {
            copyFileSync(fixtureSourcePath, fixturePath, constants.COPYFILE_FICLONE);
        } catch {
            copyFileSync(fixtureSourcePath, fixturePath);
        }
        const textSentinel = Date.now().toString();
        const text = `large pdf free text ${textSentinel}`;

        await openPdfInApp(page, fixturePath, LARGE_PDF_TIMEOUT_MS);
        await waitForPdfLoaded(page, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(page, LARGE_PDF_TIMEOUT_MS);
        await openAnnotationsTab(page, 30_000);
        expect(await createFreeTextAnnotation(page, text)).toBeGreaterThan(0);
        try {
            await waitForSaveFrontierReady(page, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        } catch (error) {
            const debugState = await collectLargePdfAnnotationDebugState(page).catch(() => null);
            const editorState = await page.evaluate(() => ({
                activeElement: document.activeElement?.outerHTML.slice(0, 1_000) ?? null,
                activeTool: globalThis.__evbE2E.getActiveWorkspaceHost()
                    ?.querySelector('.notes-panel .tool-button.is-active')
                    ?.getAttribute('data-tool') ?? null,
                editors: Array.from(document.querySelectorAll<HTMLElement>('.freeTextEditor')).map(editor => ({
                    html: editor.outerHTML.slice(0, 2_000),
                    page: editor.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
                    text: editor.textContent ?? '',
                })),
            })).catch(() => null);
            throw new Error(`FreeText save frontier did not become ready: ${JSON.stringify({
                debugState,
                editorState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }

        const agentSaveResult = await saveLargePdfViaAgentAction(page);
        if (!agentSaveResult) {
            await saveViaWindowHandle(page, LARGE_PDF_TIMEOUT_MS);
        }
        const savedState = await readWorkspaceStateValues<{
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(page, [
            'workingCopyPath',
            'originalPath',
        ]);
        const savedPath = typeof agentSaveResult?.status?.originalPath === 'string'
            ? agentSaveResult.status.originalPath
            : typeof agentSaveResult?.status?.workingCopyPath === 'string'
                ? agentSaveResult.status.workingCopyPath
                : typeof savedState.workingCopyPath === 'string'
                    ? savedState.workingCopyPath
                    : fixturePath;
        const savedNotes = await readPdfNoteContents(savedPath);
        // The headless contenteditable helper can omit its first typed token;
        // the timestamp suffix still identifies this editor uniquely.
        const savedFreeText = savedNotes.filter(note => note.contents.endsWith(`pdf free text ${textSentinel}`));
        expect(savedFreeText, JSON.stringify({
            agentSaveResult,
            savedPath,
            savedState,
            savedNotes: savedNotes.slice(0, 20),
        })).toEqual([expect.objectContaining({
            name: expect.stringMatching(/^evb-freetext:freetext-[0-9a-f-]{36}$/u),
            popup: '',
            subtype: '/FreeText',
        })]);
        const persistedText = savedFreeText[0]?.contents;
        const persistedName = savedFreeText[0]?.name;
        expect(persistedText).toBeTruthy();
        expect(persistedName).toMatch(/^evb-freetext:freetext-[0-9a-f-]{36}$/u);

        // Require the durable original to reach the crash checkpoint before
        // stopping Electron. The restarted process must restore this tab
        // itself; an explicit open would exercise a different lifecycle.
        const expectedFixtureRealPath = realpathSync(fixturePath);
        const liveDocumentState = await readWorkspaceStateValues<{
            originalPath?: string | null;
            workingCopyPath?: string | null;
        }>(page, [
            'originalPath',
            'workingCopyPath',
        ]);
        expect(
            typeof liveDocumentState.originalPath === 'string'
                ? realpathSync(liveDocumentState.originalPath)
                : null,
            JSON.stringify(liveDocumentState),
        ).toBe(expectedFixtureRealPath);
        await waitForCrashCheckpointPath(session.name, expectedFixtureRealPath);

        const restartedSession = await sessionFixture.restart({
            clean: false,
            hard: true,
            keepNuxt: true,
        });
        expect(restartedSession).not.toBeNull();
        const restartedPage = restartedSession!.page;
        await expect.poll(async () => {
            const state = await readWorkspaceStateValues<{originalPath?: string | null;}>(restartedPage, ['originalPath']);
            return typeof state.originalPath === 'string'
                ? realpathSync(state.originalPath)
                : null;
        }, {timeout: LARGE_PDF_TIMEOUT_MS}).toBe(expectedFixtureRealPath);
        await waitForPdfLoaded(restartedPage, LARGE_PDF_TIMEOUT_MS);
        await waitForViewerInteractive(restartedPage, LARGE_PDF_TIMEOUT_MS);
        const restoredDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
        expect(restoredDebugState.annotationDirty, JSON.stringify(restoredDebugState)).toBe(false);
        expect(restoredDebugState.hasAnnotationChanges, JSON.stringify(restoredDebugState)).toBe(false);

        const reopenedNotes = await readPdfNoteContents(fixturePath);
        expect(reopenedNotes.filter(note => note.contents === persistedText)).toEqual([expect.objectContaining({
            name: persistedName,
            popup: '',
            subtype: '/FreeText',
        })]);

        const secondText = `large pdf second free text ${Date.now()}`;
        await openAnnotationsTab(restartedPage, 30_000);
        await clickAnnotationTool(restartedPage, 'Text', 30_000);
        await restartedPage.evaluate(async () => {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        });
        await restartedPage.waitForFunction(() => {
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            const activeTool = host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null;
            const layer = host?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
            return activeTool !== 'text' || layer?.classList.contains('freetextEditing') === true;
        }, {timeout: 15_000});
        const editorHydrationDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
        const editorHydrationDomState = await restartedPage.evaluate(() => {
            const host = globalThis.__evbE2E.getActiveWorkspaceHost();
            const layer = host?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
            return {
                activeTool: host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null,
                editorCount: host?.querySelectorAll('.freeTextEditor:not(.pdf-comment-marker-anchor-editor)').length ?? 0,
                layerClassName: layer?.className ?? null,
            };
        });
        expect(editorHydrationDebugState.annotationDirty, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe(false);
        expect(editorHydrationDebugState.hasLivePdfJsAnnotationChanges, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe(false);
        expect(editorHydrationDomState.activeTool, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toBe('text');
        expect(editorHydrationDomState.layerClassName, JSON.stringify({
            editorHydrationDebugState,
            editorHydrationDomState,
        })).toContain('freetextEditing');
        let secondFreeTextCount: number;
        try {
            secondFreeTextCount = await createFreeTextAnnotationWithPointer(
                restartedPage,
                secondText,
                {
                    x: 0.72,
                    y: 0.68,
                },
            );
        } catch (error) {
            const failedEditorDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
            throw new Error(`Restored FreeText creation failed: ${JSON.stringify({
                editorHydrationDebugState,
                editorHydrationDomState,
                failedEditorDebugState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        expect(secondFreeTextCount).toBeGreaterThan(0);
        try {
            await waitForSaveFrontierReady(restartedPage, NOTE_TEXT_ENTRY_TIMEOUT_MS);
        } catch (error) {
            const failedFrontierDebugState = await collectLargePdfAnnotationDebugState(restartedPage);
            const failedFrontierDomState = await restartedPage.evaluate(() => {
                const host = globalThis.__evbE2E.getActiveWorkspaceHost();
                const workspace = (window as Window & {__evbTestApi?: {getActiveWorkspaceHandle?: () => {
                    getAutomationStateSnapshot?: () => unknown;
                    getToolbarSnapshot?: () => unknown;
                } | null;};}).__evbTestApi?.getActiveWorkspaceHandle?.() ?? null;
                const layer = host?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
                return {
                    activeElement: document.activeElement?.outerHTML.slice(0, 1_000) ?? null,
                    activeTool: host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null,
                    editorCount: host?.querySelectorAll('.freeTextEditor:not(.pdf-comment-marker-anchor-editor)').length ?? 0,
                    editors: Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []).map(editor => ({
                        id: editor.id,
                        text: editor.textContent ?? '',
                        classes: editor.className,
                    })),
                    layerClassName: layer?.className ?? null,
                    toolbar: workspace?.getToolbarSnapshot?.() ?? null,
                    automationState: workspace?.getAutomationStateSnapshot?.() ?? null,
                };
            });
            throw new Error(`Restored FreeText save frontier did not become ready: ${JSON.stringify({
                failedFrontierDebugState,
                failedFrontierDomState,
                cause: error instanceof Error ? error.message : String(error),
            })}`);
        }
        const secondAgentSaveResult = await saveLargePdfViaAgentAction(restartedPage);
        if (!secondAgentSaveResult) {
            await saveViaWindowHandle(restartedPage, LARGE_PDF_TIMEOUT_MS);
        }
        const twiceSavedNotes = await readPdfNoteContents(fixturePath);
        expect(twiceSavedNotes.filter(note => note.contents === persistedText)).toHaveLength(1);
        expect(twiceSavedNotes.filter(note => note.contents === secondText)).toHaveLength(1);
    }, LARGE_PDF_TIMEOUT_MS);
});
