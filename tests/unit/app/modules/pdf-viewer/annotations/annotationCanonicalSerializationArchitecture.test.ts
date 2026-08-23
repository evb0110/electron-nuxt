import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

function source(path: string) {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('canonical annotation serialization architecture', () => {
    it('does not retain raw PDF.js editors in deferred selection cleanup callbacks', () => {
        for (const path of [
            'app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationHighlight.ts',
            'app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationCrud.ts',
        ]) {
            const contents = source(path);
            expect(contents).toContain('const editorElement = editor?.div ?? null;');
            expect(contents).not.toMatch(/const clearSelection\w* = \(\) => \{[\s\S]{0,1200}editor\?\.div/u);
        }
    });

    it('keeps workspace annotation projections out of the PDF serializer', () => {
        const contents = source('app/modules/pdf-viewer/runtime/composables/pdf/usePdfSerialization.ts');
        expect(contents).not.toContain('annotationComments: Ref<');
        expect(contents).not.toContain('getAnnotationCommentsSnapshot');
        expect(contents).not.toContain('mergeAnnotationCommentSaveSnapshot');
        expect(contents).not.toContain('applyAnnotationPayload');
        expect(contents).toContain('projectAnnotationBackendMutations(options.annotationSerializationPlan, \'pdf-lib-rewrite\')');
    });

    it('routes print serialization through the canonical viewer transaction', () => {
        const contents = source('app/modules/workspace-shell/composables/createPrintableSourceDataResolver.ts');
        const transactionStart = contents.indexOf('mode: \'print\'');
        const transactionEnd = contents.indexOf('resolvePdfViewerSaveTransactionFinalBytes(printTransaction)');
        expect(transactionStart).toBeGreaterThan(-1);
        expect(transactionEnd).toBeGreaterThan(transactionStart);
        const printTransaction = contents.slice(transactionStart, transactionEnd);
        expect(printTransaction).toContain('serializeResult: true');
        expect(printTransaction).toContain('source: deps.source');
        expect(contents).not.toContain('serializePrintableSourceData');
        expect(contents).not.toContain('commitAnnotationSave');
    });

    it('runs the dirty print transaction under the document operation lease', () => {
        const orchestration = source('app/modules/workspace-shell/useWorkspaceOrchestration.ts');
        const resolverStart = orchestration.indexOf('createPrintableSourceDataResolver({');
        const resolverEnd = orchestration.indexOf('async function ensurePrintReady');
        expect(resolverStart).toBeGreaterThan(-1);
        expect(resolverEnd).toBeGreaterThan(resolverStart);
        const printResolver = orchestration.slice(resolverStart, resolverEnd);
        expect(printResolver).toContain('runWithDocumentOperationLease: documentOperationLease.runExclusive');
        expect(orchestration).not.toContain('mode: \'print\'');
    });
});
