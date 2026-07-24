import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { BUNDLED_OCR_LANGUAGE_CODES } from '@contracts/ocrLanguages';
import {
    createElectronBuilderResourcePlan,
    renderElectronBuilderResources,
} from '@scripts/generateElectronBuilderResources';
import {
    createPlatformApiArtifactPlan,
    generatePlatformApiArtifacts,
} from '@scripts/platform-api/generatePlatformApiArtifacts';
import { NATIVE_TOOL_RESOURCE_FAMILIES } from '@scripts/nativeResourceManifest';

describe('build artifact generation', () => {
    it('plans both platform API consumers from the canonical descriptor', () => {
        const firstPlan = createPlatformApiArtifactPlan();

        expect(createPlatformApiArtifactPlan()).toEqual(firstPlan);
        expect(firstPlan.map(artifact => artifact.relativePath)).toEqual([
            'app/platform/generated/browserPlatformPathDescriptorsGenerated.ts',
            'app/platform/generated/createLazyBrowserPlatformApiGenerated.ts',
        ]);
        expect(firstPlan[0]?.content).toContain('browserPlatformPathDescriptorsGenerated');
        expect(firstPlan[1]?.content).toContain('createLazyBrowserPlatformApiGenerated');
    });

    it('writes platform API artifacts byte-stably and repairs generated drift', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-platform-api-'));
        try {
            await expect(generatePlatformApiArtifacts({projectRoot: root})).resolves.toBe(true);
            await expect(generatePlatformApiArtifacts({projectRoot: root})).resolves.toBe(false);

            const [firstArtifact] = createPlatformApiArtifactPlan();
            if (!firstArtifact) {
                throw new Error('Missing platform API artifact plan');
            }
            const outputPath = path.join(root, firstArtifact.relativePath);
            await writeFile(outputPath, '// drift\n', 'utf8');
            await expect(generatePlatformApiArtifacts({projectRoot: root})).resolves.toBe(true);
            await expect(readFile(outputPath, 'utf8')).resolves.toBe(firstArtifact.content);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('generates Electron Builder OCR and native resource manifests from their registries', async () => {
        const plan = await createElectronBuilderResourcePlan();
        const rendered = renderElectronBuilderResources();
        const builderConfig = await readFile(path.join(process.cwd(), 'electron-builder.yml'), 'utf8');

        expect(plan).toEqual({
            content: rendered,
            relativePath: '.tmp/generated-electron-builder-resources.yml',
        });
        expect(builderConfig).toContain('extends: ./.tmp/generated-electron-builder-resources.yml');
        for (const code of BUNDLED_OCR_LANGUAGE_CODES) {
            expect(rendered).toContain(`      - ${code}.traineddata`);
        }
        for (const family of NATIVE_TOOL_RESOURCE_FAMILIES) {
            for (const platform of [
                'darwin',
                'linux',
                'win32',
            ]) {
                expect(rendered).toContain(
                    `${family.sourceRootSegments.join('/')}/${platform}-\${arch}`,
                );
            }
        }
        expect(rendered).toContain('!share/poppler/CMakeLists.txt');
    });
});
