import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdtemp,
    mkdir,
    writeFile,
} from 'node:fs/promises';
import {
    join,
    resolve,
} from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const { buildDependencyGraph } = await import(pathToFileURL(resolve(process.cwd(), 'scripts/architecture/dep-graph.mjs')).href);

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
});
