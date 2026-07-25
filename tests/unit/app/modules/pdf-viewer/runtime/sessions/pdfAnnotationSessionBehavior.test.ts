import {
    existsSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const root = process.cwd();
const sessionPath = 'app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession.ts';

function read(path: string) {
    return readFileSync(join(root, path), 'utf8');
}

function TypeScriptFiles(path: string): string[] {
    return readdirSync(join(root, path), {withFileTypes: true}).flatMap((entry) => {
        const child = join(path, entry.name);
        return entry.isDirectory()
            ? TypeScriptFiles(child)
            : entry.name.endsWith('.ts')
                ? [child]
                : [];
    });
}

describe('PDF annotation session authority', () => {
    it('is the only runtime constructor of the canonical Store and Application', () => {
        const constructors = [
            ...TypeScriptFiles('app/modules/pdf-viewer/runtime'),
            ...TypeScriptFiles('app/modules/pdf-viewer/tools'),
        ].filter(path => /new (?:AnnotationStore|AnnotationApplication)\b/.test(read(path)));

        expect(constructors).toEqual([sessionPath]);
        expect(read(sessionPath)).toMatch(
            /new AnnotationApplication\(documentKey, new AnnotationStore\(/,
        );
    });

    it('has no detached runtime, orchestrator, or rendering-port authority', () => {
        [
            'app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime.ts',
            'app/modules/pdf-viewer/runtime/annotations/useAnnotationOrchestrator.ts',
            'app/modules/pdf-viewer/runtime/annotations/createAttachablePdfAnnotationRenderingPort.ts',
            'app/modules/pdf-viewer/runtime/annotations/annotationOrchestrator.ts',
            'app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntimeBridge.ts',
        ].forEach(path => expect(existsSync(join(root, path))).toBe(false));

        const source = read(sessionPath);
        expect(source).not.toMatch(/attachRenderingPort|renderingPort/);
        expect(source).toMatch(/rendering\.renderVisiblePages/);
        expect(source).toMatch(/rendering\.renderAnnotationEditorLayerForPage/);
    });

    it('commits canonical summaries synchronously before exposing projection', () => {
        const source = read(sessionPath);
        const setAnnotations = source.slice(
            source.indexOf('setAnnotations:'),
            source.indexOf('setLinkAnnotations:'),
        );
        const reconcile = setAnnotations.indexOf(
            'annotationApplication.value.reconcileLegacySummaries',
        );
        const projection = setAnnotations.indexOf(
            'return annotationProjection.value.map',
        );

        expect(reconcile).toBeGreaterThanOrEqual(0);
        expect(projection).toBeGreaterThan(reconcile);
        expect(setAnnotations).not.toMatch(/\b(?:await|nextTick|setTimeout)\b/);
    });
});
