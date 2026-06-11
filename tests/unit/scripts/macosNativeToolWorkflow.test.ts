import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const platformArchHelperPath = resolve(process.cwd(), 'scripts/release/platform-arch.sh');

async function readProjectFile(path: string) {
    return readFile(path, 'utf8');
}

function extractBrewInstallPackages(workflow: string) {
    return workflow
        .match(/^.*brew install .+$/gmu)
        ?.flatMap(command => command.replace(/^.*brew install\s+/u, '').trim().split(/\s+/u)) ?? [];
}

function extractBashArrayValues(script: string, name: string) {
    const match = new RegExp(`^${name}=\\(([^)]*)\\)`, 'mu').exec(script);
    if (!match?.[1]) {
        throw new Error(`Unable to find ${name} bash array`);
    }

    return match[1].trim().split(/\s+/u);
}

function extractShellFunction(script: string, name: string) {
    const match = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, 'mu').exec(script);
    if (!match?.[1]) {
        throw new Error(`Unable to find ${name} shell function`);
    }

    return match[1];
}

function resolveReleasePlatformArch(platform: string, arch: string) {
    return execFileSync(
        '/bin/bash',
        [
            '-lc',
            [
                'source "$1"',
                'resolve_release_target_platform_arch "$2" "$3"',
                'printf "%s|%s" "$RELEASE_PLATFORM_ARCH" "$RELEASE_EXE_SUFFIX"',
            ].join('; '),
            'bash',
            platformArchHelperPath,
            platform,
            arch,
        ],
        { encoding: 'utf8' },
    ).trim();
}

describe('macOS native tool workflow', () => {
    it('keeps unpaper documentation tooling on Homebrew packages instead of PyPI', async () => {
        const workflowPaths = [
            '.github/workflows/build.yml',
            '.github/workflows/build-mac-intel.yml',
        ];

        for (const workflowPath of workflowPaths) {
            const workflow = await readProjectFile(workflowPath);
            const brewPackages = extractBrewInstallPackages(workflow);

            expect(brewPackages).toEqual(expect.arrayContaining([
                'meson',
                'pkg-config',
                'sphinx-doc',
            ]));
            expect(workflow).toContain('brew --prefix sphinx-doc');
            expect(workflow).not.toContain('pip3 install sphinx');
        }
    });

    it('keeps local macOS bundling prerequisites aligned with CI', async () => {
        const workflow = await readProjectFile('.github/workflows/build.yml');
        const bundleAll = await readProjectFile('scripts/bundle-all-macos.sh');
        const bundleUnpaper = await readProjectFile('scripts/bundle-leptonica-unpaper-macos.sh');
        const ciBrewPackages = extractBrewInstallPackages(workflow);
        const localBrewPackages = extractBashArrayValues(bundleAll, 'DEPS');
        const unpaperBuildPackages = [
            'meson',
            'pkg-config',
            'sphinx-doc',
        ];

        expect(localBrewPackages).toEqual(expect.arrayContaining(unpaperBuildPackages));
        expect(ciBrewPackages).toEqual(expect.arrayContaining(unpaperBuildPackages));
        expect(bundleUnpaper).toContain('sphinx-build is required');
        expect(bundleUnpaper).toContain('brew --prefix sphinx-doc');
    });

    it('maps release platform and architecture tags through the shared shell helper', () => {
        expect(resolveReleasePlatformArch('mac', 'arm64')).toBe('darwin-arm64|');
        expect(resolveReleasePlatformArch('mac', 'x64')).toBe('darwin-x64|');
        expect(resolveReleasePlatformArch('linux', 'x64')).toBe('linux-x64|');
        expect(resolveReleasePlatformArch('win', 'arm64')).toBe('win32-arm64|.exe');
    });

    it('keeps the macOS packaged-tool retry tripwire limited to exit 137 after signature verification', async () => {
        const verifier = await readProjectFile('scripts/verify-packaged-native-tools.sh');
        const smokeFunction = extractShellFunction(verifier, 'run_macos_packaged_tool_smoke');

        expect(verifier).toContain('source "$(dirname "$0")/release/platform-arch.sh"');
        expect(smokeFunction).toContain('[ "$exit_code" -ne 137 ] || [ "$attempt" -ge 2 ]');
        expect(smokeFunction).toContain('codesign --verify --strict --verbose=2 "$tool_path"');
        expect(smokeFunction).toContain('attempt=$((attempt + 1))');
    });

    it('keeps packaged unpaper required outside Windows and smoke-tested on macOS', async () => {
        const sourceMatrix = await readProjectFile('scripts/check-native-tools-source-matrix.sh');
        const verifier = await readProjectFile('scripts/verify-packaged-native-tools.sh');
        const bundleUnpaper = await readProjectFile('scripts/bundle-leptonica-unpaper-macos.sh');
        const sourceMatrixCheckTag = extractShellFunction(sourceMatrix, 'check_tag');

        expect(sourceMatrixCheckTag).toContain('check_file_for_tag "resources/tesseract/$tag/bin/unpaper$exe_suffix" "unpaper" "$tag"');
        expect(sourceMatrixCheckTag).toContain('SKIP    unpaper: not bundled on Windows');
        expect(verifier).toContain('unpaper binary');
        expect(verifier).toContain('run_macos_packaged_tool_smoke "unpaper"');
        expect(bundleUnpaper).toContain('if "$DEST/bin/unpaper" --help > /dev/null 2>&1; then');
        expect(bundleUnpaper).toContain('exit 1');
    });
});
