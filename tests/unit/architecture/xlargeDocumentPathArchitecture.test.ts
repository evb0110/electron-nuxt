import {
    existsSync,
    readdirSync,
    readFileSync,
} from 'node:fs';
import {
    extname,
    relative,
    resolve,
} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const REPOSITORY_ROOT = resolve(process.cwd());
const PRODUCTION_DIRECTORIES = [
    'app',
    'electron',
    'packages',
] as const;
const SOURCE_EXTENSIONS = new Set([
    '.js',
    '.jsx',
    '.mjs',
    '.mts',
    '.cts',
    '.ts',
    '.tsx',
    '.vue',
]);
const BROWSER_MODULE_PREFIXES = [
    'app/platform/browser/',
    'app/platform/browser-api/',
] as const;

type TWholeDocumentPrimitive =
  | 'readDocumentBytes'
  | 'PDFDocument.load'
  | 'PDF.js getData'
  | 'PDF.js saveDocument'
  | 'fs.readFile'
  | 'fs.readFileSync'
  | 'Blob/File.arrayBuffer';

interface ISourceCallSite {
    modulePath: string;
    primitive: TWholeDocumentPrimitive;
    line: number;
    sourceLine: string;
}

interface IWholeDocumentAllowlistEntry {
    module: string;
    primitive: TWholeDocumentPrimitive;
    occurrences: number;
    maximumBytesClassifier: string;
    reason: string;
    removalCondition: string;
}

interface IKnownNonDocumentRead {
    module: string;
    pattern: RegExp;
    reason: string;
}

const WHOLE_DOCUMENT_ALLOWLIST: readonly IWholeDocumentAllowlistEntry[] = [
    {
        module:
      'app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient.ts',
        primitive: 'readDocumentBytes',
        occurrences: 2,
        maximumBytesClassifier:
      'EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES, 96 MiB nonnative compatibility fallback',
        reason:
      'The legacy worker-unavailable path materializes a path-backed PDF before importing shapes.',
        removalCondition:
      'Remove both reads when the worker path returns a typed capability error or a bounded chunk reader.',
    },
    {
        module:
      'app/modules/pdf-viewer/engine/pdf-serialization-worker-client/runSerializationWorkerRequest.ts',
        primitive: 'readDocumentBytes',
        occurrences: 1,
        maximumBytesClassifier:
      'BROWSER_MAX_FULL_READ_BYTES, 16 MiB byte compatibility cap; native reload rejects before reading',
        reason:
      'A disposable serialization worker failure reloads the exact working copy into a JS request.',
        removalCondition:
      'Remove the reload when native or worker serialization accepts the path and fails with a typed capability error.',
    },
    {
        module:
      'app/modules/pdf-viewer/runtime/composables/pdf/usePdfSerialization.ts',
        primitive: 'readDocumentBytes',
        occurrences: 2,
        maximumBytesClassifier:
      'BROWSER_MAX_FULL_READ_BYTES, 16 MiB nonnative compatibility fallback; native path must fail closed',
        reason:
      'Legacy serialization and placed-image recovery paths ask the renderer for whole working-copy bytes.',
        removalCondition:
      'Remove the reads when every path-backed serialization recovery returns a path or bounded chunks.',
    },
    {
        module:
      'app/modules/workspace-shell/composables/useWorkspaceSplitPayload.ts',
        primitive: 'readDocumentBytes',
        occurrences: 2,
        maximumBytesClassifier:
      'BROWSER_MAX_FULL_READ_BYTES, 16 MiB compatibility fallback; native path split handoff must fail closed',
        reason:
      'The split payload compatibility path materializes the working copy for renderer handoff.',
        removalCondition:
      'Remove both reads when split handoff is path-backed or uses <=8 MiB chunks.',
    },
    {
        module:
      'app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations.ts',
        primitive: 'PDFDocument.load',
        occurrences: 1,
        maximumBytesClassifier:
      'EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES, 96 MiB path-fallback classifier; no local byte guard',
        reason:
      'Shape import parses a complete byte buffer in the in-memory compatibility operation.',
        removalCondition:
      'Remove the whole-document load when shape import consumes the native path index or bounded page data.',
    },
    {
        module:
      'app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits.ts',
        primitive: 'PDFDocument.load',
        occurrences: 1,
        maximumBytesClassifier:
      'Caller-owned Uint8Array with no maximum byte classifier, legacy in-memory operation',
        reason:
      'The renderer rewrite backend loads the complete document before applying edits.',
        removalCondition:
      'Remove the whole-document load when path-backed serialization uses native append or a bounded worker route.',
    },
    {
        module:
      'app/modules/pdf-viewer/engine/pdf-serialization-operations/deleteEmbeddedAnnotation.ts',
        primitive: 'PDFDocument.load',
        occurrences: 1,
        maximumBytesClassifier:
      'Caller-owned Uint8Array with no maximum byte classifier, legacy in-memory operation',
        reason:
      'Embedded annotation deletion remains a complete in-memory rewrite.',
        removalCondition:
      'Remove the whole-document load when deletion runs through path-backed native serialization.',
    },
    {
        module:
      'app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPdfAnnotationNamesByPage.ts',
        primitive: 'PDFDocument.load',
        occurrences: 1,
        maximumBytesClassifier:
      'Annotation enrichment page caps, but no maximum byte classifier in this helper',
        reason:
      'The browser and in-memory annotation identity fallback reparses PDF.js bytes as a complete document.',
        removalCondition:
      'Remove the load when all desktop path sources use the native annotation index and browser-only use is isolated.',
    },
    {
        module:
      'app/modules/pdf-viewer/engine/pdf-bookmark-serialization/rewriteBookmarks.ts',
        primitive: 'PDFDocument.load',
        occurrences: 1,
        maximumBytesClassifier:
      'Caller-owned Uint8Array with no maximum byte classifier, legacy in-memory operation',
        reason: 'Bookmark rewrite is a complete in-memory document operation.',
        removalCondition:
      'Remove the whole-document load when bookmark serialization accepts a path-backed operation.',
    },
    {
        module:
      'app/modules/pdf-viewer/engine/pdf-serialization-operations/updateEmbeddedAnnotationText.ts',
        primitive: 'PDFDocument.load',
        occurrences: 1,
        maximumBytesClassifier:
      'Caller-owned Uint8Array with no maximum byte classifier, legacy in-memory operation',
        reason:
      'Embedded note updates load and save the complete document in JavaScript.',
        removalCondition:
      'Remove the whole-document load when note updates use native incremental serialization.',
    },
    {
        module:
      'app/modules/pdf-viewer/engine/serialization/pdf-serialization-annotations/applyCanonicalAnnotationIdentityBindings.ts',
        primitive: 'PDFDocument.load',
        occurrences: 1,
        maximumBytesClassifier:
      'Caller-owned Uint8Array with no maximum byte classifier, legacy in-memory operation',
        reason:
      'Canonical identity binding still parses a complete byte buffer before PDF.js save.',
        removalCondition:
      'Remove the whole-document load when identity binding moves to the path-backed annotation index.',
    },
    {
        module: 'electron/image/pdfConversion.ts',
        primitive: 'PDFDocument.load',
        occurrences: 1,
        maximumBytesClassifier:
      'PDF_COMBINE_SMALL_MEMORY_MAX_INPUT_BYTES, 512 MiB per-input compatibility cap',
        reason:
      'The image-to-PDF compatibility combine path loads a temporary PDF in memory.',
        removalCondition:
      'Remove the load when the path-backed native combine route owns this conversion.',
    },
    {
        module: 'electron/image/pdfCombineShared.ts',
        primitive: 'PDFDocument.load',
        occurrences: 1,
        maximumBytesClassifier: 'maxInputBytes, 512 MiB default legacy cap',
        reason:
      'The JS combine route loads an input PDF while image inputs use separate bounded image reads.',
        removalCondition:
      'Remove the load when PDF inputs stay path-backed through native combine.',
    },
    {
        module: 'electron/features/page-ops/main/cropLocal.ts',
        primitive: 'PDFDocument.load',
        occurrences: 2,
        maximumBytesClassifier:
      'PAGE_OPS_LOCAL_FALLBACK_MAX_BYTES, 16 MiB compatibility fallback after native failure',
        reason:
      'The local crop fallback loads the working copy only after the native operation declines a small input.',
        removalCondition:
      'Remove both loads when native crop returns a typed capability error and no JS fallback remains.',
    },
    {
        module: 'packages/pdf-core/pdfPrintLayout.ts',
        primitive: 'PDFDocument.load',
        occurrences: 2,
        maximumBytesClassifier:
      'Caller-owned Uint8Array with no maximum byte classifier, legacy in-memory utility',
        reason:
      'Print layout helpers load complete source and output byte arrays in the shared PDF core.',
        removalCondition:
      'Remove both loads when print layout work is path-backed or limited to explicitly small input.',
    },
    {
        module: 'packages/pdf-core/loadPdfStructure.ts',
        primitive: 'PDFDocument.load',
        occurrences: 1,
        maximumBytesClassifier:
      'Caller-owned Uint8Array with no maximum byte classifier, structural in-memory utility',
        reason:
      'Structural inspection accepts bytes directly and does not classify path size at this layer.',
        removalCondition:
      'Remove the whole-document load when structural inspection consumes bounded qpdf/native results.',
    },
    {
        module:
      'app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPdfAnnotationNamesByPage.ts',
        primitive: 'PDF.js getData',
        occurrences: 1,
        maximumBytesClassifier:
      'Annotation enrichment page caps, but no maximum byte classifier in this helper',
        reason:
      'The browser and in-memory annotation identity fallback asks PDF.js for the whole document.',
        removalCondition:
      'Remove getData when browser-only enrichment no longer shares the desktop path flow.',
    },
    {
        module:
      'app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction.ts',
        primitive: 'PDF.js saveDocument',
        occurrences: 1,
        maximumBytesClassifier:
      'PDF.js save output has no <=8 MiB chunk classifier, legacy in-memory save route',
        reason:
      'The compatibility save route materializes a complete PDF.js output byte array.',
        removalCondition:
      'Remove saveDocument from desktop path saves when native append owns the path output.',
    },
    {
        module: 'electron/image/pdfConversion.ts',
        primitive: 'fs.readFile',
        occurrences: 1,
        maximumBytesClassifier:
      'PDF_COMBINE_SMALL_MEMORY_MAX_INPUT_BYTES, 512 MiB per-input compatibility cap',
        reason:
      'The compatibility combine path reads a temporary PDF into a whole byte array.',
        removalCondition:
      'Remove the read when the path-backed native combine route owns this conversion.',
    },
    {
        module: 'electron/image/pdfCombineShared.ts',
        primitive: 'fs.readFile',
        occurrences: 1,
        maximumBytesClassifier: 'maxInputBytes, 512 MiB default legacy cap',
        reason:
      'The JS combine route reads a PDF input; image reads in the same module are classified separately.',
        removalCondition:
      'Remove the PDF read when PDF inputs remain on the native path-backed combine route.',
    },
    {
        module: 'electron/features/page-ops/main/cropLocal.ts',
        primitive: 'fs.readFile',
        occurrences: 2,
        maximumBytesClassifier:
      'PAGE_OPS_LOCAL_FALLBACK_MAX_BYTES, 16 MiB compatibility fallback after native failure',
        reason:
      'The local crop fallback reads the working copy only after the native operation declines a small input.',
        removalCondition:
      'Remove both reads when native crop returns a typed capability error and no JS fallback remains.',
    },
    {
        module: 'electron/image/tryCreatePdfWithNativeImageCombiner.ts',
        primitive: 'fs.readFile',
        occurrences: 1,
        maximumBytesClassifier:
      'PDF_COMBINE_MAX_OUTPUT_BYTES, shared 16 MiB output cap',
        reason:
      'The native image combiner reads its generated PDF output back into a byte array.',
        removalCondition:
      'Remove the read when callers retain the validated output path.',
    },
    {
        module: 'electron/image/tryCreatePdfFromInputPathsNative.ts',
        primitive: 'fs.readFile',
        occurrences: 1,
        maximumBytesClassifier:
      'PDF_COMBINE_MAX_OUTPUT_BYTES, shared 16 MiB cap for file-backed and byte-returning native paths',
        reason:
      'The native assembler compatibility API reads its generated PDF output for a byte-returning caller.',
        removalCondition:
      'Remove the read when all desktop combine callers consume the output path.',
    },
];

const KNOWN_NON_DOCUMENT_READS: readonly IKnownNonDocumentRead[] = [
    {
        module: 'electron/djvu/buildOptimizedPdf.ts',
        pattern: /const fileData = await readFile\(imagePaths\[i\]!\)/u,
        reason: 'Raster image input, not a document PDF.',
    },
    {
        module: 'electron/features/djvu/main/buildCompactDjvuAwarePdfFromDjvu.ts',
        pattern: /const data = await readFile\(path\);/u,
        reason: 'Generated Netpbm or PBM image probe, not a document PDF.',
    },
    {
        module: 'electron/features/documents/main/nativePdfPreview.ts',
        pattern: /const bytes = new Uint8Array\(await readFile\(outputPath\)\)/u,
        reason: 'JPEG preview output, not a document PDF.',
    },
    {
        module: 'electron/features/djvu/main/pagePreview.ts',
        pattern: /bytes: await readFile\(pngPath\)/u,
        reason: 'PNG page preview output, not a document PDF.',
    },
    {
        module: 'electron/features/image-export/main/export.ts',
        pattern: /const sourceBytes = await readFile\(sourcePath\)/u,
        reason: 'Rendered PPM image output, not a document PDF.',
    },
    {
        module:
      'electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal.ts',
        pattern: /const tiffBytes = await readFile\(pagePath\)/u,
        reason: 'TIFF page input, not a document PDF.',
    },
    {
        module:
      'electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal.ts',
        pattern: /const tiffBytes = await readFile\(page\.path\)/u,
        reason: 'TIFF page input, not a document PDF.',
    },
    {
        module: 'electron/features/scan-cleanup/createScanCleanupPreviewService.ts',
        pattern: /const bytes = new Uint8Array\(await readFile\(path\)\)/u,
        reason: 'PNG scan-cleanup preview output, not a document PDF.',
    },
    {
        module: 'electron/image/pdfCombineShared.ts',
        pattern: /const originalBytes = await readFile\(sourcePath\)/u,
        reason: 'Image input in the PDF combine module, not a document PDF.',
    },
    {
        module: 'electron/image/pdfCombineShared.ts',
        pattern:
      /const tiffBytes = new Uint8Array\(await readFile\(sourcePath\)\)/u,
        reason: 'TIFF image input in the PDF combine module, not a document PDF.',
    },
];

const KNOWN_ARRAY_BUFFER_EXCEPTIONS: readonly IKnownNonDocumentRead[] = [
    {
        module:
      'app/modules/pdf-viewer/runtime/composables/pdf/usePdfSerialization.ts',
        pattern: /new Uint8Array\(await blob\.arrayBuffer\(\)\)/u,
        reason: 'Placed image Blob, not a document PDF.',
    },
    {
        module:
      'app/modules/workspace-shell/agent/createDocumentAgentPageImageCapture.ts',
        pattern: /new Uint8Array\(await blob\.arrayBuffer\(\)\)/u,
        reason: 'Captured page image Blob, not a document PDF.',
    },
    {
        module: 'electron/ocr/languageModels.ts',
        pattern: /response\.arrayBuffer\(\)/u,
        reason: 'Downloaded OCR model payload, not a document PDF.',
    },
];

function readSource(modulePath: string) {
    return readFileSync(resolve(REPOSITORY_ROOT, modulePath), 'utf8');
}

function collectSourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            return collectSourceFiles(path);
        }
        return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    });
}

function toModulePath(path: string) {
    return relative(REPOSITORY_ROOT, path).split('\\').join('/');
}

function isBrowserModule(modulePath: string) {
    return BROWSER_MODULE_PREFIXES.some((prefix) =>
        modulePath.startsWith(prefix),
    );
}

function sourceLines(source: string) {
    return source.split('\n');
}

function findCallSites(
    modulePath: string,
    source: string,
    primitive: TWholeDocumentPrimitive,
    expression: RegExp,
) {
    const lines = sourceLines(source);
    return Array.from(source.matchAll(expression), (match): ISourceCallSite => {
        const index = match.index ?? 0;
        const line = source.slice(0, index).split('\n').length;
        return {
            modulePath,
            primitive,
            line,
            sourceLine: lines[line - 1]?.trim() ?? '',
        };
    });
}

function collectWholeDocumentCallSites() {
    const callSites: ISourceCallSite[] = [];
    for (const rootDirectory of PRODUCTION_DIRECTORIES) {
        const rootPath = resolve(REPOSITORY_ROOT, rootDirectory);
        for (const filePath of collectSourceFiles(rootPath)) {
            const modulePath = toModulePath(filePath);
            const source = readFileSync(filePath, 'utf8');
            callSites.push(
                ...findCallSites(
                    modulePath,
                    source,
                    'readDocumentBytes',
                    /\breadDocumentBytes\s*\(/gu,
                )
                    .filter(() => modulePath !== 'app/utils/documentBytes.ts')
                    .filter(
                        (site) => !isBoundedOpenFlowRead(modulePath, source, site.line),
                    ),
                ...findCallSites(
                    modulePath,
                    source,
                    'PDFDocument.load',
                    /\bPDFDocument\.load\s*\(/gu,
                )
                    .filter(() => !isBrowserModule(modulePath))
                    .filter(() => modulePath !== 'electron/ocr/worker/pdfAssembler.ts'),
                ...findCallSites(
                    modulePath,
                    source,
                    'PDF.js getData',
                    /\.\s*getData\s*\(/gu,
                ).filter(() => !isBrowserModule(modulePath)),
                ...findCallSites(
                    modulePath,
                    source,
                    'PDF.js saveDocument',
                    /\.\s*saveDocument\s*\(/gu,
                ).filter(() => !isBrowserModule(modulePath)),
                ...findCallSites(
                    modulePath,
                    source,
                    'fs.readFile',
                    /\breadFile\s*\(/gu,
                ).filter((site) => isDocumentFsRead(modulePath, source, site)),
                ...findCallSites(
                    modulePath,
                    source,
                    'fs.readFileSync',
                    /\breadFileSync\s*\(/gu,
                ).filter((site) => isDocumentFsRead(modulePath, source, site)),
                ...findCallSites(
                    modulePath,
                    source,
                    'Blob/File.arrayBuffer',
                    /\.\s*arrayBuffer\s*\(/gu,
                )
                    .filter(() => !isBrowserModule(modulePath))
                    .filter(() => modulePath !== 'app/utils/pdfPrint.ts')
                    .filter(
                        (site) => !isKnownArrayBufferException(modulePath, site.sourceLine),
                    ),
            );
        }
    }
    return callSites;
}

function isBoundedOpenFlowRead(
    modulePath: string,
    source: string,
    line: number,
) {
    if (
        modulePath !==
    'app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow.ts'
    ) {
        return false;
    }
    const lines = sourceLines(source);
    return lines
        .slice(line - 1, line + 4)
        .join('\n')
        .includes('maxBytes: maxInMemoryPdfBytes');
}

function isKnownNonDocumentRead(modulePath: string, sourceLine: string) {
    return KNOWN_NON_DOCUMENT_READS.some(
        (entry) => entry.module === modulePath && entry.pattern.test(sourceLine),
    );
}

function isDocumentFsRead(
    modulePath: string,
    source: string,
    site: ISourceCallSite,
) {
    if (
        site.sourceLine.includes('.readFile(') ||
    site.sourceLine.includes('.readFileSync(')
    ) {
        return false;
    }
    if (/,\s*['"]utf-?8['"]\s*\)/u.test(site.sourceLine)) {
        return false;
    }
    if (isKnownNonDocumentRead(modulePath, site.sourceLine)) {
        return false;
    }
    const knownPdfReadModules = new Set([
        'electron/utils/printHandoff.ts',
        'electron/image/pdfConversion.ts',
        'electron/image/pdfCombineShared.ts',
        'electron/ocr/worker/pageTextClassifier.ts',
        'electron/features/page-ops/main/cropLocal.ts',
        'electron/ocr/worker/main.ts',
        'electron/search/extractTextWithPdfjs.ts',
        'electron/features/djvu/main/pdfExport.ts',
        'electron/features/documents/main/pdfConformance.ts',
        'electron/features/documents/main/analyzePdfConformanceFileDirect.ts',
        'electron/image/tryCreatePdfWithNativeImageCombiner.ts',
        'electron/image/tryCreatePdfFromInputPathsNative.ts',
    ]);
    if (knownPdfReadModules.has(modulePath)) {
        return true;
    }
    const lines = sourceLines(source);
    const context = lines
        .slice(Math.max(0, site.line - 3), site.line + 2)
        .join('\n');
    return /\b(?:pdf(?:data|bytes|path)|sourcePdf|inputPdf|convertedPdf|workingCopyPath)\b/iu.test(
        context,
    );
}

function isKnownArrayBufferException(modulePath: string, sourceLine: string) {
    return KNOWN_ARRAY_BUFFER_EXCEPTIONS.some(
        (entry) => entry.module === modulePath && entry.pattern.test(sourceLine),
    );
}

function allowlistKey(
    entry: Pick<IWholeDocumentAllowlistEntry, 'module' | 'primitive'>,
) {
    return `${entry.module}::${entry.primitive}`;
}

function getActualCounts(callSites: readonly ISourceCallSite[]) {
    const counts = new Map<string, number>();
    for (const callSite of callSites) {
        const key = allowlistKey({
            module: callSite.modulePath,
            primitive: callSite.primitive,
        });
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

function assertKnownCalls(
    entries: readonly IKnownNonDocumentRead[],
    primitive: TWholeDocumentPrimitive,
) {
    for (const entry of entries) {
        const source = readSource(entry.module);
        expect(
            source.split('\n').some((line) => entry.pattern.test(line)),
            `${entry.module} must retain its ${primitive} exception: ${entry.reason}`,
        ).toBe(true);
    }
}

describe('xlarge document path architecture', () => {
    it('keeps the desktop source boundary and its byte budgets explicit', () => {
        const documentBytesSource = readSource('app/utils/documentBytes.ts');
        const openFlowSource = readSource(
            'app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow.ts',
        );
        const openPolicySource = readSource(
            'app/utils/openPathSecondaryPerformancePolicy.ts',
        );
        const persistenceFramesSource = readSource(
            'packages/contracts/documentPersistenceFrames.ts',
        );
        const documentContractSource = readSource(
            'packages/contracts/electronApiDocuments.ts',
        );
        const pdfDocumentSource = readSource(
            'app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource.ts',
        );
        const browserDocumentConstants = readSource(
            'app/platform/browser/browserDocumentConstants.ts',
        );
        const browserPdfValidationSource = readSource(
            'app/platform/browser-api/browserPdfValidation.ts',
        );
        const browserPageOpsSource = readSource(
            'app/platform/browser-api/createBrowserPageOpsCapability.ts',
        );
        const documentPersistenceSource = readSource(
            'app/modules/workspace-shell/composables/document-session/createDocumentPersistence.ts',
        );
        const serializationWorkerSource = readSource(
            'app/modules/pdf-viewer/engine/pdf-serialization-worker-client/runSerializationWorkerRequest.ts',
        );
        const browserCombineSource = readSource(
            'app/platform/browser-api/createCombinedPdfFromPaths.ts',
        );
        const browserCombineWorkerSource = readSource(
            'app/platform/browser-api/browserPdfCombine.worker.ts',
        );
        const browserSearchSource = readSource(
            'app/platform/browser-api/createBrowserSearchCapability.ts',
        );

        expect(documentBytesSource).toContain(
            'const DEFAULT_DOCUMENT_READ_CHUNK_BYTES = 4 * 1024 * 1024;',
        );
        expect(documentBytesSource).toContain(
            'documentFiles.readFileRange(path, offset, nextChunkLength)',
        );
        expect(documentBytesSource).toContain('maxBytes?: number;');
        expect(openFlowSource).toContain('if (size > maxInMemoryPdfBytes)');
        expect(openFlowSource).toContain('maxBytes: maxInMemoryPdfBytes');
        expect(openPolicySource).toContain('maxInMemoryPdfBytes: 16 * MEBIBYTE');
        expect(openPolicySource).toMatch(
            /maxInMemoryPdfBytes:\s*profile\.lowMemory\s*\?\s*4 \* MEBIBYTE/u,
        );
        expect(persistenceFramesSource).toContain(
            'PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024',
        );
        expect(documentContractSource).toContain(
            'IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024',
        );
        expect(documentContractSource).toContain(
            'PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES = 512 * 1024',
        );
        expect(documentContractSource).toContain(
            'PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES = 4 * 1024 * 1024',
        );
        expect(pdfDocumentSource).toContain(
            'const PDFJS_BLOB_URL_MAX_BYTES = 16 * 1024 * 1024;',
        );
        expect(pdfDocumentSource).toContain(
            'if (src.size <= PDFJS_BLOB_URL_MAX_BYTES)',
        );
        expect(browserDocumentConstants).toContain(
            'BROWSER_MAX_FULL_READ_BYTES = PDF_COMBINE_MAX_OUTPUT_BYTES',
        );
        expect(browserPdfValidationSource).toContain(
            'if (size > BROWSER_MAX_FULL_READ_BYTES)',
        );
        expect(browserPageOpsSource).toContain(
            'const BROWSER_PAGE_OP_PDF_MAX_BYTES = BROWSER_MAX_FULL_READ_BYTES;',
        );
        expect(browserPageOpsSource).toContain(
            'const BROWSER_PAGE_OP_COMBINED_INPUT_MAX_BYTES = BROWSER_MAX_FULL_READ_BYTES;',
        );
        expect(documentPersistenceSource).toContain(
            'const MAX_IN_MEMORY_PDF_BYTES = BROWSER_MAX_FULL_READ_BYTES;',
        );
        expect(serializationWorkerSource).toContain(
            'const SERIALIZATION_WORKER_MAX_INPUT_BYTES = BROWSER_MAX_FULL_READ_BYTES;',
        );
        expect(browserCombineSource).toContain(
            'const BROWSER_COMBINED_PDF_TOTAL_INPUT_MAX_BYTES = BROWSER_MAX_FULL_READ_BYTES;',
        );
        expect(browserCombineSource).toContain(
            'const BROWSER_COMBINED_PDF_MAX_OUTPUT_BYTES = BROWSER_MAX_FULL_READ_BYTES;',
        );
        expect(browserCombineWorkerSource).toContain(
            'const MAX_OUTPUT_BYTES = BROWSER_MAX_FULL_READ_BYTES;',
        );
        expect(browserSearchSource).not.toContain('BROWSER_SEARCH_MAX_BYTES');
    });

    it('keeps both PDF.js workers sparse for path-backed multi-gigabyte documents', () => {
        const pdfjsPatch = readSource('patches/pdfjs-dist@5.7.284.patch');
        const assetCopySource = readSource('scripts/copy-pdfjs-assets.mjs');

        expect(pdfjsPatch).toContain('diff --git a/build/pdf.worker.mjs b/build/pdf.worker.mjs');
        expect(pdfjsPatch).toContain(
            'diff --git a/legacy/build/pdf.worker.mjs b/legacy/build/pdf.worker.mjs',
        );
        expect(pdfjsPatch.match(/^\+ {2}_storedChunks = new Map\(\);$/gmu)).toHaveLength(2);
        expect(
            pdfjsPatch.match(/^\+ {4}super\(new Uint8Array\(0\), 0, 0, null\);$/gmu),
        ).toHaveLength(2);
        expect(
            pdfjsPatch.match(/^\+ {4}this\._storeBytes\(begin, new Uint8Array\(chunk\)\);$/gmu),
        ).toHaveLength(2);
        expect(
            pdfjsPatch.match(/^\+ {4}const byte = this\._getStoredByte\(pos\);$/gmu),
        ).toHaveLength(2);
        expect(pdfjsPatch).not.toContain(
            '+    this.pos++;\n+    return this._getStoredByte(pos);',
        );
        expect(assetCopySource).toContain('join(root, \'build\', \'pdf.worker.mjs\')');
        expect(assetCopySource).not.toContain(
            'join(root, \'build\', \'pdf.worker.min.mjs\')',
        );
    });

    it('keeps malformed-xref recovery bounded for range-backed documents in both workers', () => {
        const pdfjsPatch = readSource('patches/pdfjs-dist@5.7.284.patch');
        const publicWorkerSource = readSource('public/pdf/pdf.worker.min.mjs');
        const workerPaths = [
            'build/pdf.worker.mjs',
            'legacy/build/pdf.worker.mjs',
        ] as const;
        for (const workerPath of workerPaths) {
            const workerDiffStart = pdfjsPatch.indexOf(
                `diff --git a/${workerPath} b/${workerPath}`,
            );
            const nextDiffStart = pdfjsPatch.indexOf(
                '\ndiff --git ',
                workerDiffStart + 1,
            );
            const workerPatch = pdfjsPatch.slice(
                workerDiffStart,
                nextDiffStart === -1 ? undefined : nextDiffStart,
            );

            expect(workerDiffStart).toBeGreaterThanOrEqual(0);
            expect(workerPatch).toContain('+  indexObjectsBounded() {');
            expect(workerPatch).toContain('+    const SCAN_WINDOW_BYTES = 1024 * 1024;');
            expect(workerPatch).toContain('+      const buffer = stream.getByteRange(windowBegin, windowEnd);');
            expect(workerPatch).toContain('+        stream.discardChunksBefore(windowEnd - HEADER_OVERLAP_BYTES);');
            expect(workerPatch).not.toContain(
                'PDF.js xref recovery is disabled for range-backed documents above 16 MiB',
            );
        }

        expect(publicWorkerSource).toContain('indexObjectsBounded');
        expect(publicWorkerSource).toContain('discardChunksBefore');
        expect(publicWorkerSource).not.toContain(
            'PDF.js xref recovery is disabled for range-backed documents above 16 MiB',
        );
    });

    it('keeps native and worker failures fail-closed for desktop paths', () => {
        const annotationPreparationSource = readSource(
            'app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/preparePdfAnnotationNameRead.ts',
        );
        const annotationNativeBranchStart = annotationPreparationSource.indexOf(
            'if (nativePdfSource)',
        );
        const annotationRendererFallbackStart = annotationPreparationSource.indexOf(
            'const {collectPdfAnnotationNamesByPage}',
            annotationNativeBranchStart,
        );
        const annotationNativeBranch = annotationPreparationSource.slice(
            annotationNativeBranchStart,
            annotationRendererFallbackStart,
        );
        const shapeWorkerSource = readSource(
            'app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient.ts',
        );
        const shapeNativeServiceSource = readSource(
            'electron/features/documents/main/pdfEmbeddedShapeIndex.ts',
        );
        const combineSource = readSource(
            'electron/image/tryCreatePdfFromInputPathsNative.ts',
        );
        const combineErrorSource = readSource('packages/contracts/pdfCombineErrors.ts');
        const nativeErrorSource = readSource('packages/contracts/nativeErrors.ts');
        const cropSource = readSource('electron/features/page-ops/main/crop.ts');
        const cropLocalSource = readSource('electron/features/page-ops/main/cropLocal.ts');
        const nativeCropSource = readSource('electron/features/page-ops/main/nativeCrop.ts');

        expect(annotationNativeBranchStart).toBeGreaterThanOrEqual(0);
        expect(annotationRendererFallbackStart).toBeGreaterThan(
            annotationNativeBranchStart,
        );
        expect(annotationNativeBranch).toContain(
            'annotationNameSkipReason: \'unreadable-source\'',
        );
        expect(annotationNativeBranch).not.toContain(
            'collectPdfAnnotationNamesByPage',
        );
        const nativeShapeBranchStart = shapeWorkerSource.indexOf(
            'if (isNativeEmbeddedShapeIndexSource(path))',
        );
        const rendererShapeFallbackStart = shapeWorkerSource.indexOf(
            'if (!canUseEmbeddedShapeImportWorker())',
            nativeShapeBranchStart,
        );
        const nativeShapeBranch = shapeWorkerSource.slice(
            nativeShapeBranchStart,
            rendererShapeFallbackStart,
        );
        expect(nativeShapeBranchStart).toBeGreaterThanOrEqual(0);
        expect(rendererShapeFallbackStart).toBeGreaterThan(nativeShapeBranchStart);
        expect(nativeShapeBranch).toContain(
            'return importEmbeddedShapeAnnotationsFromNativePath(path, options);',
        );
        expect(nativeShapeBranch).not.toContain('readDocumentBytes');
        expect(nativeShapeBranch).not.toContain('type: \'path-start\'');
        expect(nativeShapeBranch).not.toContain('type: \'path-chunk\'');
        expect(shapeNativeServiceSource).toContain(
            'buildPdfEmbeddedShapeIndexCommandArgs(inputPath, outputPath, getPdfNativeToolPaths().qpdf)',
        );
        expect(shapeNativeServiceSource).toContain(
            'commandLabel: \'evb-pdf-page-ops(embedded-shape-index)\'',
        );
        expect(shapeNativeServiceSource).toContain('readPdfEmbeddedShapeIndexChunk');
        expect(shapeNativeServiceSource).toContain('cancelPdfEmbeddedShapeIndex');
        expect(shapeNativeServiceSource).toContain('releasePdfEmbeddedShapeIndex');
        expect(combineSource).toContain(
            'failureMode?: \'fallback\' | \'capability-error\';',
        );
        expect(combineSource).toContain('if (isStrictNativeFailure(options))');
        expect(combineSource).toContain('throw createNativeCapabilityError(');
        expect(combineErrorSource).toContain('class PdfCombineCapabilityError');
        expect(combineErrorSource).toContain('isPdfCombineCapabilityError');
        expect(nativeErrorSource).toContain('\'too-large\'');
        expect(cropSource).toContain('tryGetPageGeometryWithNativePageOps');
        expect(cropSource).toContain('evb-pdf-page-ops(page-geometry)');
        expect(cropSource).not.toContain('CROP_LOCAL_FALLBACK_MAX_REQUESTED_PAGES');
        expect(cropLocalSource).toContain('assertPageOpsLocalFallbackAllowed');
        expect(nativeCropSource).toContain(
            'PAGE_OPS_LOCAL_FALLBACK_MAX_BYTES = 16 * 1024 * 1024',
        );
    });

    it('requires every current whole-document call site to have one complete allowlist entry', () => {
        const callSites = collectWholeDocumentCallSites();
        const actualCounts = getActualCounts(callSites);
        const allowlistKeys = WHOLE_DOCUMENT_ALLOWLIST.map(allowlistKey);
        const actualKeys = Array.from(actualCounts.keys()).sort();
        const sortedAllowlistKeys = [...allowlistKeys].sort();

        expect(WHOLE_DOCUMENT_ALLOWLIST.length).toBeGreaterThan(0);
        expect(new Set(allowlistKeys).size).toBe(WHOLE_DOCUMENT_ALLOWLIST.length);
        expect(sortedAllowlistKeys).toEqual(actualKeys);
        for (const entry of WHOLE_DOCUMENT_ALLOWLIST) {
            expect(entry.module).toMatch(/^(?:app|electron|packages)\/[^*]+$/u);
            expect(entry.module).not.toContain('..');
            expect(existsSync(resolve(REPOSITORY_ROOT, entry.module))).toBe(true);
            expect(
                Number.isSafeInteger(entry.occurrences) && entry.occurrences > 0,
            ).toBe(true);
            expect(entry.maximumBytesClassifier.trim()).not.toBe('');
            expect(entry.maximumBytesClassifier).toMatch(
                /bytes|MiB|GiB|classifier|uncapped/iu,
            );
            expect(entry.reason.trim()).not.toBe('');
            expect(entry.removalCondition.trim()).not.toBe('');
            expect(actualCounts.get(allowlistKey(entry))).toBe(entry.occurrences);
        }
    });

    it('keeps image, sidecar, and browser byte reads outside the PDF violator inventory', () => {
        const callSites = collectWholeDocumentCallSites();

        assertKnownCalls(KNOWN_NON_DOCUMENT_READS, 'fs.readFile');
        for (const entry of KNOWN_NON_DOCUMENT_READS) {
            const source = readSource(entry.module);
            const matchingLines = source
                .split('\n')
                .filter((line) => entry.pattern.test(line));
            expect(matchingLines.length).toBeGreaterThan(0);
            expect(
                callSites.filter(
                    (site) =>
                        site.modulePath === entry.module &&
            entry.pattern.test(site.sourceLine),
                ),
            ).toEqual([]);
        }

        const arrayBufferCallSites = [] as ISourceCallSite[];
        for (const rootDirectory of PRODUCTION_DIRECTORIES) {
            const rootPath = resolve(REPOSITORY_ROOT, rootDirectory);
            for (const filePath of collectSourceFiles(rootPath)) {
                const modulePath = toModulePath(filePath);
                if (
                    isBrowserModule(modulePath) ||
          modulePath === 'app/utils/pdfPrint.ts'
                ) {
                    continue;
                }
                arrayBufferCallSites.push(
                    ...findCallSites(
                        modulePath,
                        readFileSync(filePath, 'utf8'),
                        'Blob/File.arrayBuffer',
                        /\.\s*arrayBuffer\s*\(/gu,
                    ),
                );
            }
        }
        expect(arrayBufferCallSites).toEqual(
            expect.arrayContaining(
                KNOWN_ARRAY_BUFFER_EXCEPTIONS.map((entry) =>
                    expect.objectContaining({ modulePath: entry.module }),
                ),
            ),
        );
        expect(
            arrayBufferCallSites.every((site) =>
                isKnownArrayBufferException(site.modulePath, site.sourceLine),
            ),
        ).toBe(true);
    });
});
