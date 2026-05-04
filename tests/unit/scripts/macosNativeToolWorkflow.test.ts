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

            expect(workflow).toContain('brew install tesseract poppler qpdf djvulibre ffmpeg meson pkg-config sphinx-doc');
            expect(workflow).toContain('SPHINX_BIN="$(brew --prefix sphinx-doc)/bin"');
            expect(workflow).toContain('export PATH="$SPHINX_BIN:$PATH"');
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
});
