import { readFile } from 'node:fs/promises';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { getNativeSourceMatrixCheckEntries } from '@scripts/nativeResourceManifest';

const platformArchHelperPath = resolve(process.cwd(), 'scripts/release/platform-arch.sh');
const sourceMatrixScriptPath = resolve(process.cwd(), 'scripts/check-native-tools-source-matrix.sh');

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

function writeExecutable(filePath: string, body: string) {
    writeFileSync(filePath, body);
    chmodSync(filePath, 0o755);
}

function runSourceMatrixAsLinuxX64Host() {
    const binDir = mkdtempSync(join(tmpdir(), 'evb-native-matrix-bin-'));
    writeExecutable(join(binDir, 'uname'), [
        '#!/bin/sh',
        'case "$1" in',
        '  -s) echo Linux ;;',
        '  -m) echo x86_64 ;;',
        '  *) /usr/bin/uname "$@" ;;',
        'esac',
        '',
    ].join('\n'));
    return execFileSync(
        '/bin/bash',
        [
            sourceMatrixScriptPath,
            '--all',
        ],
        {
            encoding: 'utf8',
            env: {
                ...process.env,
                EVB_NATIVE_TOOLS_ALLOW_HOST_CI_GEN: '1',
                PATH: `${binDir}:${process.env.PATH ?? ''}`,
            },
        },
    );
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
        expect(ciBrewPackages).not.toContain('ffmpeg');
        expect(localBrewPackages).not.toContain('ffmpeg');
        expect(bundleUnpaper).toContain('build-minimal-ffmpeg-for-unpaper.sh');
        expect(bundleUnpaper).toContain('Unexpected video-codec closure leaked into the unpaper bundle');
    });

    it('pins a PNM-only FFmpeg build for unpaper instead of the video-codec closure', async () => {
        const minimalFfmpeg = await readProjectFile('scripts/build-minimal-ffmpeg-for-unpaper.sh');
        expect(minimalFfmpeg).toContain('resolve_path()');
        expect(minimalFfmpeg).toContain('refusing unsafe FFmpeg build cleanup target');
        expect(minimalFfmpeg).toContain('rm -rf -- "$SOURCE_DIR" "$INSTALL_PREFIX"');

        expect(minimalFfmpeg).toContain('FFMPEG_COMMIT="db69d06eeeab4f46da15030a80d539efb4503ca8"');
        expect(minimalFfmpeg).toContain('--disable-everything');
        expect(minimalFfmpeg).toContain('--enable-decoder=pam,pbm,pgm,pgmyuv,ppm');
        expect(minimalFfmpeg).toContain('--enable-encoder=pam,pbm,pgm,pgmyuv,ppm');
        expect(minimalFfmpeg).toContain('--enable-demuxer=image2,image2pipe');
        expect(minimalFfmpeg).toContain('--enable-muxer=image2,image2pipe');
        expect(minimalFfmpeg).not.toContain('--enable-libx264');
        expect(minimalFfmpeg).not.toContain('--enable-libaom');
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
        expect(smokeFunction).toContain('local max_attempts=18');
        expect(smokeFunction).toContain('[ "$exit_code" -ne 137 ] || [ "$attempt" -ge "$max_attempts" ]');
        expect(smokeFunction).toContain('codesign --verify --strict --verbose=2 "$tool_path"');
        expect(smokeFunction).toContain('retrying ($attempt/$max_attempts)');
        expect(smokeFunction).toContain('attempt=$((attempt + 1))');
        expect(smokeFunction).toContain('is_macos_app_adhoc_signed "$mac_app_path"');
        expect(smokeFunction).toContain('run_macos_ad_hoc_payload_smoke_mirror "$tool_name" "$tool_path" "$@"');
        expect(verifier).toContain('Signature=adhoc|TeamIdentifier=not set');
        expect(verifier).toContain('Ad-hoc macOS app execution was killed by provenance policy');
    });

    it('keeps packaged unpaper required outside Windows and smoke-tested on macOS', async () => {
        const verifier = await readProjectFile('scripts/verify-packaged-native-tools.sh');
        const bundleUnpaper = await readProjectFile('scripts/bundle-leptonica-unpaper-macos.sh');

        expect(getNativeSourceMatrixCheckEntries('linux-x64')).toContainEqual({
            kind: 'required',
            label: 'unpaper',
            path: 'resources/tesseract/linux-x64/bin/unpaper',
            type: 'file',
        });
        expect(getNativeSourceMatrixCheckEntries('win32-x64')).toContainEqual({
            kind: 'skip',
            label: 'unpaper',
            reason: 'not bundled on Windows',
        });
        expect(verifier).toContain('run_macos_packaged_tool_smoke "unpaper" "$(packaged_entry_path unpaper)" --help');
        expect(bundleUnpaper).toContain('if "$DEST/bin/unpaper" --help > /dev/null 2>&1; then');
        expect(bundleUnpaper).toContain('exit 1');
    });

    it('derives every comparable macOS native-tool dylib closure through one shared policy', async () => {
        const dylibBundle = await readProjectFile('scripts/lib/macos-dylib-bundle.sh');
        const bundleDjvu = await readProjectFile('scripts/bundle-djvu-macos.sh');
        const bundlePdfTools = await readProjectFile('scripts/bundle-pdf-tools-macos.sh');
        const bundleTesseract = await readProjectFile('scripts/bundle-tesseract-macos.sh');
        const bundleUnpaper = await readProjectFile('scripts/bundle-leptonica-unpaper-macos.sh');

        expect(dylibBundle).toContain('macos_copy_dylib_closure()');
        expect(dylibBundle).toContain('macos_list_dylib_dependencies "$file"');
        expect(dylibBundle).toContain('macos_resolve_dylib_source "$dependency" "$search_root"');
        expect(dylibBundle).toContain('cp -L "$dependency_source"');
        expect(dylibBundle).toContain('macos_verify_relocated_file()');
        expect(dylibBundle).toContain('Bundled dependency closure is missing');
        expect(dylibBundle).toContain('@loader_path/$dependency_name');
        expect(dylibBundle).toContain('@executable_path/../lib/$dependency_name');

        for (const bundler of [
            bundleDjvu,
            bundlePdfTools,
            bundleTesseract,
            bundleUnpaper,
        ]) {
            expect(bundler).toContain('source "$SCRIPT_DIR/lib/macos-dylib-bundle.sh"');
            expect(bundler).toContain('macos_bundle_dylib_closure');
            expect(bundler).not.toContain('copy_deps_recursive()');
        }

        expect(bundleDjvu).not.toContain('DEPS=(');
        expect(bundleDjvu).toContain('assert-packaged-tool-smoke.mjs');
        expect(bundleDjvu).toContain('Error: Bundled ddjvu failed its smoke test');
        expect(bundleDjvu).not.toContain('Warning: ddjvu test failed');
    });

    it('copies a transitive @loader_path dylib that is absent from the seeded bundle', () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-macos-dylib-closure-'));
        const fakeBin = join(root, 'fake-bin');
        const brewRoot = join(root, 'brew');
        const sourceLib = join(brewRoot, 'Cellar', 'webp', '1.0', 'lib');
        const destinationBin = join(root, 'bundle', 'bin');
        const destinationLib = join(root, 'bundle', 'lib');
        const pdfinfo = join(destinationBin, 'pdfinfo');

        for (const directory of [
            fakeBin,
            sourceLib,
            destinationBin,
            destinationLib,
        ]) {
            mkdirSync(directory, { recursive: true });
        }
        for (const filePath of [
            pdfinfo,
            join(sourceLib, 'libwebp.7.dylib'),
            join(sourceLib, 'libsharpyuv.0.dylib'),
            join(destinationLib, 'libwebp.7.dylib'),
        ]) {
            writeFileSync(filePath, 'fixture');
        }

        writeExecutable(join(fakeBin, 'otool'), [
            '#!/bin/bash',
            'file="$2"',
            'echo "$file:"',
            'case "$(basename "$file")" in',
            '  pdfinfo) echo "  @rpath/libwebp.7.dylib (compatibility version 1.0.0)" ;;',
            '  libwebp.7.dylib)',
            '    echo "  @rpath/libwebp.7.dylib (compatibility version 1.0.0)"',
            '    echo "  @loader_path/libsharpyuv.0.dylib (compatibility version 1.0.0)"',
            '    ;;',
            '  libsharpyuv.0.dylib)',
            '    echo "  @rpath/libsharpyuv.0.dylib (compatibility version 1.0.0)"',
            '    echo "  /usr/lib/libSystem.B.dylib (compatibility version 1.0.0)"',
            '    ;;',
            'esac',
            '',
        ].join('\n'));

        execFileSync('/bin/bash', [
            '-c',
            [
                'source "$1"',
                'macos_copy_dylib_closure "$2" "$3" "$4" "$2/libwebp.7.dylib"',
                'test -f "$2/libsharpyuv.0.dylib"',
            ].join('; '),
            'bash',
            resolve(process.cwd(), 'scripts/lib/macos-dylib-bundle.sh'),
            destinationLib,
            brewRoot,
            pdfinfo,
        ], {env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        }});
    });

    it('keeps macOS packaged executables under Contents/MacOS/native-tools', async () => {
        const afterPack = await readProjectFile('scripts/afterPack.cjs');
        const afterSign = await readProjectFile('scripts/afterSign.cjs');
        const verifier = await readProjectFile('scripts/verify-packaged-native-tools.sh');

        expect(afterPack).toContain('function nativeToolsDirForContext(context)');
        expect(afterPack).toContain('Contents\', \'MacOS\', \'native-tools\'');
        expect(afterPack).toContain('moveMacNativeToolResources(context)');
        expect(afterPack).toContain('makeTreeOwnerWritable(nativeToolsDir)');
        expect(afterSign).toContain('const nativeToolsDir = path.join(appPath, \'Contents\', \'MacOS\', \'native-tools\');');
        expect(verifier).toContain('find "$release_dir" -path "*/Contents/MacOS/native-tools"');
        expect(getNativeSourceMatrixCheckEntries('darwin-arm64')).toEqual(expect.arrayContaining([
            {
                kind: 'required',
                label: 'djvused',
                path: 'resources/djvulibre/darwin-arm64/bin/djvused',
                type: 'file',
            },
            {
                kind: 'required',
                label: 'djvudump',
                path: 'resources/djvulibre/darwin-arm64/bin/djvudump',
                type: 'file',
            },
        ]));
        expect(verifier).toContain('check_file "$entry_path" "$entry_label"');
        expect(verifier).toContain('run_macos_packaged_tool_smoke "djvused" "$(packaged_entry_path djvused)" --help');
        expect(verifier).toContain('run_macos_packaged_tool_smoke "djvudump" "$(packaged_entry_path djvudump)" --help');
        expect(verifier).not.toContain('run_macos_packaged_tool_smoke "djvused" "$resource_root');
        expect(verifier).toContain('run_macos_packaged_tool_smoke "evb-pdf-image-combine-compact-manifest" "$(packaged_entry_path evb-pdf-image-combine)" --compact-manifest');
    });

    it('keeps the packaged native-tool payload writable for ShipIt quarantine removal', async () => {
        const afterPack = await readProjectFile('scripts/afterPack.cjs');
        const packagedVerifier = await readProjectFile('scripts/verify-packaged-native-tools.sh');

        expect(afterPack).toContain('const requiredMode = stat.isDirectory() ? 0o300 : 0o200');
        expect(afterPack).toContain('fs.chmodSync(currentPath, nextMode)');
        expect(packagedVerifier).toContain('ShipIt cannot remove quarantine metadata');
        expect(packagedVerifier).toContain('! -perm -u+w');
        expect(packagedVerifier).toContain('\\( -type f -o -type d \\)');
    });

    it('keeps native executable signing and source checks aligned', async () => {
        const afterSign = await readProjectFile('scripts/afterSign.cjs');
        const sourceMatrix = await readProjectFile('scripts/check-native-tools-source-matrix.sh');
        const verifier = await readProjectFile('scripts/verify-packaged-native-tools.sh');

        expect(afterSign).toContain('const HARDENED_RUNTIME_ENTITLEMENTS');
        expect(afterSign).toContain('filePath.endsWith(\'.so\')');
        // Every re-signed Mach-O executable (native tools + Electron/Squirrel helpers)
        // must get the hardened runtime, or notarization rejects the bundle. Shared
        // libraries are excluded via isMacSharedLibrary.
        expect(afterSign).toContain('function signOptionsForCodeFile(filePath, identity)');
        expect(afterSign).toContain('signTarget(filePath, identity, signOptionsForCodeFile(filePath, identity))');
        expect(afterSign).toContain('directoryPath.endsWith(\'.framework\')');
        expect(afterSign).toContain('entitlements: HARDENED_RUNTIME_ENTITLEMENTS');
        expect(afterSign).toContain('runtime: true');
        expect(sourceMatrix).toContain('nativeResourceManifestCli.ts');
        expect(sourceMatrix).toContain('source-matrix "$tag"');
        expect(sourceMatrix).toContain('echo "  CI-GEN  $label: $path"');
        expect(verifier).toContain('Absolute symlink in $label');
    });

    it('verifies macOS packaged native tool architectures against the release target', async () => {
        const verifier = await readProjectFile('scripts/verify-packaged-native-tools.sh');

        expect(verifier).toContain('macos_macho_arch_for_release_arch()');
        expect(verifier).toContain('check_macos_file_arch()');
        expect(verifier).toContain('expected_macho_arch="$(macos_macho_arch_for_release_arch "$arch")"');
        expect(verifier).toContain('arch_mismatch=0');
        expect(verifier).toContain('check_macos_file_arch "$file" "$expected_macho_arch"');
    });

    it('lets the release quality gate defer CI-generated Linux resources explicitly', () => {
        const output = runSourceMatrixAsLinuxX64Host();

        expect(output).toContain('== Checking linux-x64 ==');
        expect(output).toMatch(/(CI-GEN|OK)\s+tesseract: resources\/tesseract\/linux-x64\/bin\/tesseract/u);
        expect(output).toContain('CI-GEN  tesseract: resources/tesseract/linux-arm64/bin/tesseract');
        expect(output).toContain('Native tool source matrix check passed (--all).');
    }, 15_000);
});
