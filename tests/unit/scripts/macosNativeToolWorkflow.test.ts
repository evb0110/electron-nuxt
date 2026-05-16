import { readFile } from 'node:fs/promises';
import {
    describe,
    expect,
    it,
} from 'vitest';

async function readProjectFile(path: string) {
    return readFile(path, 'utf8');
}

describe('macOS native tool workflow', () => {
    it('installs unpaper documentation tooling through Homebrew instead of PyPI', async () => {
        const workflowPaths = [
            '.github/workflows/build.yml',
            '.github/workflows/build-mac-intel.yml',
        ];

        for (const workflowPath of workflowPaths) {
            const workflow = await readProjectFile(workflowPath);
            const brewInstallCommands = workflow.match(/^.*brew install .+$/gmu) ?? [];
            const documentationToolInstall = brewInstallCommands.find(command => command.includes('sphinx-doc'));

            expect(documentationToolInstall).toBeDefined();
            expect(documentationToolInstall).toContain('meson');
            expect(documentationToolInstall).toContain('pkg-config');
            expect(workflow).toContain('brew --prefix sphinx-doc');
            expect(workflow).not.toContain('pip3 install sphinx');
        }
    });

    it('keeps local macOS bundling prerequisites aligned with CI', async () => {
        const bundleAll = await readProjectFile('scripts/bundle-all-macos.sh');
        const bundleUnpaper = await readProjectFile('scripts/bundle-leptonica-unpaper-macos.sh');

        expect(bundleAll).toContain('sphinx-doc');
        expect(bundleUnpaper).toContain('sphinx-build is required');
        expect(bundleUnpaper).toContain('brew --prefix sphinx-doc');
    });

    it('retries transient macOS packaged tool kills after checking the signature', async () => {
        const verifier = await readProjectFile('scripts/verify-packaged-native-tools.sh');

        expect(verifier).toContain('exit_code" -ne 137');
        expect(verifier).toContain('codesign --verify --strict --verbose=2 "$tool_path"');
        expect(verifier).toContain('retrying once');
    });
});
