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

function read(path: string) {
    return readFileSync(join(process.cwd(), path), 'utf8');
}

function sourceFiles(path: string): string[] {
    return readdirSync(join(process.cwd(), path), {withFileTypes: true}).flatMap((entry) => {
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
            return sourceFiles(child);
        }
        return /\.(?:ts|vue)$/.test(entry.name) ? [child] : [];
    });
}

describe('annotation architecture boundaries', () => {
    it('keeps note-window state canonical and compatibility comments read-only', () => {
        const stateSource = read('app/types/annotationNoteWindow.ts');
        const stateBody = stateSource.match(/interface IAnnotationNoteWindowState \{([\s\S]*?)\n\}/)?.[1] ?? '';
        const properties = [...stateBody.matchAll(/^\s+(\w+)[?:]?:/gm)].map(match => match[1]);
        const noteWindowSource = read('app/modules/workspace-shell/composables/useAnnotationNoteWindows.ts');

        expect(properties).toEqual([
            'annotationId',
            'draftText',
            'minimized',
            'position',
        ]);
        expect(noteWindowSource).not.toMatch(/\bnote\.comment\s*=/);
        expect(noteWindowSource).not.toMatch(/annotationComments\.value\s*=/);
        expect(stateSource.match(/interface IAnnotationNoteWindowViewModel[\s\S]*?\n\}/)?.[0]).not.toMatch(/\bcomment\s*:/);
        expect(noteWindowSource).not.toMatch(/\bcommentProjection\b|\bnote\.comment\b/);
        expect(noteWindowSource).not.toMatch(/legacyStableKey/);
        expect(noteWindowSource).not.toMatch(/pendingText\s*=\s*new Map<string/);
        expect(noteWindowSource).toContain('const runtime = new Map<AnnotationId');
    });

    it('routes every annotation feature PDF.js internal through the leased bridge', () => {
        const productionPaths = [
            ...sourceFiles('app/modules/pdf-viewer/annotations'),
            ...sourceFiles('app/modules/pdf-viewer/runtime/annotations'),
            ...sourceFiles('app/modules/workspace-shell/composables'),
        ].filter(path => !path.includes('/annotations/bridge/'));
        const violations = productionPaths.flatMap((path) => {
            const source = read(path);
            const forbidden = [
                /from ['"]pdfjs-dist['"]/,
                /\b(?:IPdfjsEditor|AnnotationEditorUIManager)\b/,
                /@app\/services\/pdfjs\/(?:annotationEditorAdapter|annotationEditorMutation|annotationEditorCompatibility|createPdfHighlightEditorClassPatch)/,
                /\.(?:addEditListeners|removeEditListeners|updateMode|updateParams|waitForEditorsRendered)\(/,
                /__(?:freeText|evb(?!TestApi))/,
            ];
            return forbidden.some(pattern => pattern.test(source)) ? [path] : [];
        });

        expect(violations).toEqual([]);
    });

    it('has no mutable summary, move, deletion, or shape peer authority', () => {
        const commentModel = read('app/modules/pdf-viewer/annotations/usePdfAnnotationCommentModel.ts');
        const identityBridge = read('app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationIdentity.ts');
        const shapeProjection = read('app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes.ts');
        const shapeCommands = read('app/modules/pdf-viewer/tools/usePdfShapeTool.ts');
        const shapeContext = read('app/modules/pdf-viewer/tools/usePdfShapeContext.ts');
        const runtime = read('app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime.ts');
        const facade = read('app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade.ts');

        expect(commentModel).not.toMatch(/commentSummaryMemory|pendingMarkerMoves|deletedAnnotationsById/);
        expect(runtime).not.toMatch(/\bannotationReadModels\b/);
        const editorBinding = facade.match(/interface IEditorBinding \{([\s\S]*?)\n\}/)?.[1] ?? '';
        expect(editorBinding).not.toMatch(/editor:\s*object/);
        expect(identityBridge).not.toMatch(/new Map<.*Summary|commentSummaryMemory/);
        expect(shapeProjection).toContain('IManagedEmbeddedPdfShapeProjectionPort');
        expect(shapeProjection).not.toContain('IManagedEmbeddedPdfShapeStore');
        expect(shapeCommands).toMatch(/createShapeProjected|replaceShapeGeometryProjected|deleteShapeProjected/);
        expect(shapeCommands).not.toContain('usePdfShapeHistory');
        expect(shapeContext).toMatch(/finishDrawingDraft|onShapePreviewed/);
    });

    it('keeps the retired heuristic identity directory empty', () => {
        const identityPath = join(
            process.cwd(),
            'app/modules/pdf-viewer/engine/annotations/annotation-identity',
        );
        expect(existsSync(identityPath) ? readdirSync(identityPath) : []).toEqual([]);
    });
});
