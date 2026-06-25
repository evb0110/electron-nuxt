import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdir,
    mkdtemp,
    writeFile,
} from 'node:fs/promises';
import {
    join,
    resolve,
} from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const {
    buildDependencyGraph,
    findStronglyConnectedComponents,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/architecture/dep-graph.mjs')).href);
const {
    checkArchitectureBoundaryEdge,
    checkArchitectureBoundaryNode,
    checkArchitectureBoundarySource,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/architecture/boundary-check.mjs')).href
);
const {
    ANNOTATION_LATE_BOUND_EDGES,
    checkAnnotationDependencyEdge,
    checkAnnotationDependencyGraph,
} = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/architecture/annotation-dependency-graph.mjs')).href
);

describe('dependency graph', () => {
    it('fails when a configured root does not exist', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'evb-dep-graph-'));
        await mkdir(join(projectRoot, 'packages/release-selection'), { recursive: true });

        await expect(buildDependencyGraph({
            projectRoot,
            roots: ['packages/releaseSelection'],
        })).rejects.toThrow('packages/releaseSelection');
    });

    it('includes the release-selection package root', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'evb-dep-graph-'));
        await mkdir(join(projectRoot, 'packages/release-selection'), { recursive: true });
        await writeFile(join(projectRoot, 'packages/release-selection/index.ts'), 'export const releaseSelection = true;\n');

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['packages/release-selection'],
        });

        expect(graph.nodes.map((node: { file: string }) => node.file)).toEqual(['packages/release-selection/index.ts']);
    });

    it('ignores generated Vercel output when scanning all architecture roots', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'evb-dep-graph-'));
        await mkdir(join(projectRoot, 'landing/app'), { recursive: true });
        await mkdir(join(projectRoot, 'landing/.vercel/output/server'), { recursive: true });
        await writeFile(join(projectRoot, 'landing/app/app.ts'), 'export const app = true;\n');
        await writeFile(join(projectRoot, 'landing/.vercel/output/server/index.ts'), 'export const generated = true;\n');

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['landing'],
        });

        expect(graph.nodes.map((node: { file: string }) => node.file)).toEqual(['landing/app/app.ts']);
    });

    it('treats external scoped packages that share internal alias prefixes as external', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'evb-dep-graph-'));
        await mkdir(join(projectRoot, 'scripts/release'), { recursive: true });
        await writeFile(
            join(projectRoot, 'scripts/release/assert-packaged-app-contents.mjs'),
            'import asar from \'@electron/asar\';\nexport const read = asar.listPackage;\n',
        );

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['scripts'],
        });

        expect(graph.unresolvedInternalImports).toEqual([]);
    });

    it('reports strongly connected import components as dependency cycles', async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), 'evb-dep-graph-'));
        await mkdir(join(projectRoot, 'app'), { recursive: true });
        await writeFile(join(projectRoot, 'app/a.ts'), 'import \'./b\';\nexport const a = true;\n');
        await writeFile(join(projectRoot, 'app/b.ts'), 'import \'./a\';\nexport const b = true;\n');

        const graph = await buildDependencyGraph({
            projectRoot,
            roots: ['app'],
        });

        expect(graph.cycles).toEqual([{ files: [
            'app/a.ts',
            'app/b.ts',
        ] }]);
        expect(findStronglyConnectedComponents(graph.nodes, graph.edges)).toEqual([[
            'app/a.ts',
            'app/b.ts',
        ]]);
    });

    it('keeps the contracts package dependency graph acyclic', async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: ['packages/contracts'],
        });

        expect(graph.cycles).toEqual([]);
    });

    it('keeps electron code from importing app runtime modules', async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: ['electron'],
        });

        const electronToAppEdges = graph.edges.filter((edge: {
            source: string;
            target: string;
        }) => edge.source.startsWith('electron/')
            && edge.target.startsWith('app/'));
        expect(electronToAppEdges).toEqual([]);
    });

    it('requires cross-feature app module component imports to go through public entrypoints', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/components/NewInternalPanel.vue',
            specifier: '@app/modules/pdf-viewer/components/NewInternalPanel.vue',
        })).toEqual([{
            rule: 'app-cross-feature-deep-import',
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/components/NewInternalPanel.vue',
            specifier: '@app/modules/pdf-viewer/components/NewInternalPanel.vue',
            message: 'Cross-feature imports in app/modules must use public entrypoints only.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/components/PdfViewer.vue',
            specifier: '@app/modules/pdf-viewer/components/PdfViewer.vue',
        })).toEqual([{
            rule: 'app-cross-feature-deep-import',
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/components/PdfViewer.vue',
            specifier: '@app/modules/pdf-viewer/components/PdfViewer.vue',
            message: 'Cross-feature imports in app/modules must use public entrypoints only.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/public.ts',
            specifier: '@app/modules/pdf-viewer/public',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/components/WorkspaceHost.vue',
            target: 'app/modules/pdf-viewer/public/component-exports/pdfViewer.ts',
            specifier: '@app/modules/pdf-viewer/public/component-exports/pdfViewer',
        })).toEqual([]);
    });

    it('requires app pages to import modules through public entrypoints', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'app/pages/index.vue',
            target: 'app/modules/workspace-shell/components/AppShellRoot.vue',
            specifier: '@app/modules/workspace-shell/components/AppShellRoot.vue',
        })).toEqual([{
            rule: 'app-pages-module-deep-import',
            source: 'app/pages/index.vue',
            target: 'app/modules/workspace-shell/components/AppShellRoot.vue',
            specifier: '@app/modules/workspace-shell/components/AppShellRoot.vue',
            message: 'app/pages imports from app/modules must use module public entrypoints only.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/pages/mobile-reader-proof.vue',
            target: 'app/modules/workspace-shell/composables/usePdfFile.ts',
            specifier: '@app/modules/workspace-shell/composables/usePdfFile',
        })).toEqual([{
            rule: 'app-pages-module-deep-import',
            source: 'app/pages/mobile-reader-proof.vue',
            target: 'app/modules/workspace-shell/composables/usePdfFile.ts',
            specifier: '@app/modules/workspace-shell/composables/usePdfFile',
            message: 'app/pages imports from app/modules must use module public entrypoints only.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/pages/index.vue',
            target: 'app/modules/workspace-shell/public/component-exports/appShellRoot.ts',
            specifier: '@app/modules/workspace-shell/public/component-exports/appShellRoot',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/pages/mobile-reader-proof.vue',
            target: 'app/modules/workspace-shell/public.ts',
            specifier: '@app/modules/workspace-shell/public',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/pages/mobile-reader-proof.vue',
            target: 'app/modules/pdf-viewer/public/component-exports/pdfViewer.ts',
            specifier: '@app/modules/pdf-viewer/public/component-exports/pdfViewer',
        })).toEqual([]);
    });

    it('keeps retired PDF migration paths from returning', () => {
        expect(checkArchitectureBoundaryNode('app/components/pdf/PdfViewer.vue')).toEqual([{
            rule: 'retired-pdf-component-path',
            source: 'app/components/pdf/PdfViewer.vue',
            target: 'app/components/pdf/PdfViewer.vue',
            specifier: 'filesystem',
            message: 'Retired PDF components must not be recreated under app/components/pdf; use app/modules/pdf-viewer public entrypoints.',
        }]);

        expect(checkArchitectureBoundaryNode('app/composables/usePdfFile.ts')).toEqual([{
            rule: 'retired-top-level-use-pdf-file',
            source: 'app/composables/usePdfFile.ts',
            target: 'app/composables/usePdfFile.ts',
            specifier: 'filesystem',
            message: 'The retired app/composables/usePdfFile.ts path must stay retired; use app/modules/workspace-shell public entrypoints.',
        }]);
    });

    it('blocks top-level PDF composables after migration', () => {
        expect(checkArchitectureBoundaryNode('app/composables/usePdfSearch.ts')).toEqual([{
            rule: 'top-level-pdf-composable',
            source: 'app/composables/usePdfSearch.ts',
            target: 'app/composables/usePdfSearch.ts',
            specifier: 'filesystem',
            message: 'Top-level app/composables/usePdf*.ts files are blocked; keep PDF composables in feature modules.',
        }]);

        expect(checkArchitectureBoundaryNode('app/composables/usePdfAnnotations.ts')).toEqual([{
            rule: 'top-level-pdf-composable',
            source: 'app/composables/usePdfAnnotations.ts',
            target: 'app/composables/usePdfAnnotations.ts',
            specifier: 'filesystem',
            message: 'Top-level app/composables/usePdf*.ts files are blocked; keep PDF composables in feature modules.',
        }]);
    });

    it('requires browser platform API imports to go through the public entrypoint', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'app/services/pdf/combinePdfFiles.ts',
            target: 'app/platform/browser-api/createCombinedPdfFromPaths.ts',
            specifier: '@app/platform/browser-api/createCombinedPdfFromPaths',
        })).toEqual([{
            rule: 'browser-api-public-entrypoint',
            source: 'app/services/pdf/combinePdfFiles.ts',
            target: 'app/platform/browser-api/createCombinedPdfFromPaths.ts',
            specifier: '@app/platform/browser-api/createCombinedPdfFromPaths',
            message: 'Browser platform API consumers must import through app/platform/browser-api/public.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/services/pdf/combinePdfFiles.ts',
            target: 'app/platform/browser-api/public.ts',
            specifier: '@app/platform/browser-api/public',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/platform/browser-api/createBrowserDocumentsCapability.ts',
            target: 'app/platform/browser-api/browserWorkingCopyService.ts',
            specifier: '@app/platform/browser-api/browserWorkingCopyService',
        })).toEqual([]);
    });

    it('keeps the aggregate platform API limited to composition points', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/workspace-shell/composables/usePdfFile.ts',
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
        })).toEqual([{
            rule: 'platform-api-aggregate-import',
            source: 'app/modules/workspace-shell/composables/usePdfFile.ts',
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
            message: 'Import narrow platform capability contracts instead of the aggregate IPlatformApi contract.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/platform/browserPlatformPathDescriptors.ts',
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/utils/platform.ts',
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
        })).toEqual([]);
    });

    it('blocks PDF viewer engine imports back to runtime module layers', () => {
        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/pdf-viewer/engine/pdf-rerender-restoration/createPdfRerenderRestorationLogger.ts',
            target: 'app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol.ts',
            specifier: '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol',
        })).toEqual([{
            rule: 'pdf-viewer-engine-layer-back-edge',
            source: 'app/modules/pdf-viewer/engine/pdf-rerender-restoration/createPdfRerenderRestorationLogger.ts',
            target: 'app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol.ts',
            specifier: '@app/modules/pdf-viewer/runtime/rerender-protocol/pdfRerenderProtocol',
            message: 'PDF viewer engine code must not import runtime, component, tool, or public module layers; move pure contracts/helpers into engine.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/pdf-viewer/engine/pdf-search-match-scroller/createPdfSearchMatchScroller.ts',
            target: 'app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses.ts',
            specifier: '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomClasses',
        })).toEqual([]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocol.ts',
            target: 'app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocolTypes.ts',
            specifier: '@app/modules/pdf-viewer/engine/pdf-rerender-protocol/pdfRerenderProtocolTypes',
        })).toEqual([]);
    });

    it('keeps current PDF viewer engine imports inside allowed module layers', async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: ['app/modules/pdf-viewer'],
        });

        const engineLayerViolations = graph.edges
            .flatMap(checkArchitectureBoundaryEdge)
            .filter((violation: { rule: string }) => violation.rule === 'pdf-viewer-engine-layer-back-edge');

        expect(engineLayerViolations).toEqual([]);
    });

    it('keeps legacy Electron feature re-export shims thin', () => {
        expect(checkArchitectureBoundarySource(
            'electron/djvu/convert.ts',
            'export * from \'@electron/features/djvu/public\';\n',
        )).toEqual([]);

        expect(checkArchitectureBoundarySource(
            'electron/search/protocol.ts',
            'export type * from \'@electron/features/search/protocol\';\n',
        )).toEqual([]);

        expect(checkArchitectureBoundarySource(
            'electron/djvu/convert.ts',
            'import { convertDjvuToPdfFile } from \'@electron/features/djvu/public\';\nexport { convertDjvuToPdfFile };\n',
        )).toEqual([{
            rule: 'electron-legacy-feature-reexport-shim',
            source: 'electron/djvu/convert.ts',
            target: 'electron/djvu/convert.ts',
            specifier: 'source',
            message: 'Legacy Electron feature shims must stay one-line re-exports to their feature entrypoint.',
        }]);

        expect(checkArchitectureBoundarySource(
            'electron/search/protocol.ts',
            'export * from \'@electron/features/search/protocol\';\n',
        )).toEqual([{
            rule: 'electron-legacy-feature-reexport-shim',
            source: 'electron/search/protocol.ts',
            target: 'electron/search/protocol.ts',
            specifier: 'source',
            message: 'Legacy Electron feature shims must stay one-line re-exports to their feature entrypoint.',
        }]);
    });

    it('blocks direct PDF.js annotationStorage dirty-state access outside the save bridge', () => {
        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/useFileOperations.ts',
            'pdfDocument.value?.annotationStorage?.resetModified();',
        )).toEqual([{
            rule: 'annotation-storage-private-access',
            source: 'app/modules/workspace-shell/composables/useFileOperations.ts',
            target: 'app/modules/workspace-shell/composables/useFileOperations.ts',
            specifier: 'source',
            message: 'PDF.js annotationStorage dirty-state members must be accessed through the annotation save bridge.',
        }]);

        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/useFileOperations.ts',
            'const storage = document.annotationStorage;\nreturn storage?.serializable;',
        )).toEqual([{
            rule: 'annotation-storage-private-access',
            source: 'app/modules/workspace-shell/composables/useFileOperations.ts',
            target: 'app/modules/workspace-shell/composables/useFileOperations.ts',
            specifier: 'source',
            message: 'PDF.js annotationStorage dirty-state members must be accessed through the annotation save bridge.',
        }]);

        expect(checkArchitectureBoundarySource(
            'app/modules/workspace-shell/composables/useFileOperations.ts',
            'const annotationStorage = document.annotationStorage;\nreturn annotationStorage["modifiedIds"];',
        )).toEqual([{
            rule: 'annotation-storage-private-access',
            source: 'app/modules/workspace-shell/composables/useFileOperations.ts',
            target: 'app/modules/workspace-shell/composables/useFileOperations.ts',
            specifier: 'source',
            message: 'PDF.js annotationStorage dirty-state members must be accessed through the annotation save bridge.',
        }]);

        expect(checkArchitectureBoundarySource(
            'app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges.ts',
            'const storage = document.annotationStorage;\nreturn storage?.serializable;',
        )).toEqual([]);

        expect(checkArchitectureBoundarySource(
            'app/modules/pdf-viewer/runtime/annotations/useAnnotationEditorBridge.ts',
            'annotationStorage.onSetModified = handler;',
        )).toEqual([]);
    });

    it('keeps the annotation dependency graph explicit and acyclic', async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: [
                'app/modules/pdf-viewer/runtime/annotations',
                'app/modules/pdf-viewer/annotations',
                'app/modules/pdf-viewer/tools',
                'app/modules/pdf-viewer/runtime/save',
                'app/modules/pdf-viewer/engine/annotations',
                'app/modules/pdf-viewer/engine/pdf-serialization-comments',
                'app/modules/pdf-viewer/engine/pdf-serialization-operations',
                'app/modules/pdf-viewer/engine/serialization',
            ],
        });
        const result = checkAnnotationDependencyGraph(graph, { includeDirectEdgeViolations: true });

        expect(ANNOTATION_LATE_BOUND_EDGES.length).toBeGreaterThan(0);
        expect(result.violations).toEqual([]);
        expect(result.cycles).toEqual([]);
        expect(result.inventory.lateBoundEdges.length).toBe(ANNOTATION_LATE_BOUND_EDGES.length);
    });

    it('blocks new hidden annotation runtime/tool crossings', () => {
        expect(checkAnnotationDependencyEdge({
            source: 'app/modules/pdf-viewer/tools/usePdfShapeTool.ts',
            target: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts',
            specifier: '@app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud',
        })).toEqual([{
            rule: 'annotation-tools-to-runtime',
            source: 'app/modules/pdf-viewer/tools/usePdfShapeTool.ts',
            target: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts',
            specifier: '@app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud',
            message: 'PDF annotation tools must not import runtime annotation composables; share pure helpers through engine/types ports.',
        }]);

        expect(checkAnnotationDependencyEdge({
            source: 'app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes.ts',
            target: 'app/modules/pdf-viewer/tools/useAnnotationShapes.ts',
            specifier: '@app/modules/pdf-viewer/tools/useAnnotationShapes',
        })).toEqual([{
            rule: 'annotation-runtime-to-tools',
            source: 'app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes.ts',
            target: 'app/modules/pdf-viewer/tools/useAnnotationShapes.ts',
            specifier: '@app/modules/pdf-viewer/tools/useAnnotationShapes',
            message: 'Runtime annotation composables may only compose tools through the explicit shape-tool boundary.',
        }]);

        expect(checkAnnotationDependencyEdge({
            source: 'app/modules/workspace-shell/composables/useFileOperations.ts',
            target: 'app/modules/pdf-viewer/runtime/save/buildPdfAnnotationSavePlan.ts',
            specifier: '@app/modules/pdf-viewer/runtime/save/buildPdfAnnotationSavePlan',
        })).toEqual([{
            rule: 'annotation-save-public-entrypoint',
            source: 'app/modules/workspace-shell/composables/useFileOperations.ts',
            target: 'app/modules/pdf-viewer/runtime/save/buildPdfAnnotationSavePlan.ts',
            specifier: '@app/modules/pdf-viewer/runtime/save/buildPdfAnnotationSavePlan',
            message: 'Annotation save internals must be consumed through app/modules/pdf-viewer/public.',
        }]);
    });

    it('reports annotation cycle paths for negative fixtures', () => {
        const fixtureGraph = { edges: [
            {
                source: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts',
                target: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight.ts',
                specifier: 'fixture-crud-to-highlight',
            },
            {
                source: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight.ts',
                target: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts',
                specifier: 'fixture-highlight-to-crud',
            },
        ] };
        const result = checkAnnotationDependencyGraph(fixtureGraph, { includeKnownLateBoundEdges: false });

        expect(result.violations).toEqual([{
            rule: 'annotation-dependency-cycle',
            source: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts',
            target: 'app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight.ts',
            specifier: 'direct import / late-bound annotation dependency graph',
            message: 'Disallowed annotation dependency cycle: app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts -> app/modules/pdf-viewer/runtime/annotations/useAnnotationHighlight.ts -> app/modules/pdf-viewer/runtime/annotations/useAnnotationCrud.ts',
        }]);
    });
});
