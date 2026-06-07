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
const { checkArchitectureBoundaryEdge } = await import(
    pathToFileURL(resolve(process.cwd(), 'scripts/architecture/boundary-check.mjs')).href
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

    it('keeps electron features from importing legacy IPC modules', async () => {
        const graph = await buildDependencyGraph({
            projectRoot: process.cwd(),
            roots: ['electron'],
        });

        const featureToIpcEdges = graph.edges.filter((edge: {
            source: string;
            target: string;
        }) => edge.source.startsWith('electron/features/')
            && edge.target.startsWith('electron/ipc/'));
        expect(featureToIpcEdges).toEqual([]);
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
            source: 'app/composables/usePdfFile.ts',
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
        })).toEqual([{
            rule: 'platform-api-aggregate-import',
            source: 'app/composables/usePdfFile.ts',
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
            message: 'Import narrow platform capability contracts instead of the aggregate IPlatformApi contract.',
        }]);

        expect(checkArchitectureBoundaryEdge({
            source: 'app/utils/platform.ts',
            target: 'packages/contracts/platformApi.ts',
            specifier: '@contracts/platformApi',
        })).toEqual([]);
    });
});
