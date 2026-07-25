import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { getNativeSourceMatrixCheckEntries } from '@scripts/nativeResourceManifest';

describe('linux Poppler packaging', () => {
    it('bundles and verifies Poppler runtime data and fontconfig resources', async () => {
        const bundleScript = await readFile(resolve(process.cwd(), 'scripts/bundle-tools-linux.sh'), 'utf8');
        expect(bundleScript).toContain('cp -a /usr/share/poppler "$POPPLER_DIR/share/"');
        expect(bundleScript).toContain('cp -a /etc/fonts "$POPPLER_DIR/etc/"');
        expect(bundleScript).toContain('verify_dir()');
        expect(bundleScript).toContain('verify_dir "$POPPLER_DIR/share/poppler" "poppler data directory"');
        expect(bundleScript).toContain('verify_dir "$POPPLER_DIR/etc/fonts" "fontconfig directory"');
        expect(bundleScript).toContain('verify_tool "$POPPLER_DIR/bin/pdfinfo" "pdfinfo"');
        expect(bundleScript).toContain('missing_count=$((missing_count + 1))');
        expect(bundleScript).toContain('Error: Bundle verification failed');

        const verifyScript = await readFile(resolve(process.cwd(), 'scripts/verify-packaged-native-tools.sh'), 'utf8');
        expect(getNativeSourceMatrixCheckEntries('linux-x64')).toEqual(expect.arrayContaining([
            {
                kind: 'required',
                label: 'poppler data directory',
                path: 'resources/poppler/linux-x64/share/poppler',
                type: 'directory',
            },
            {
                kind: 'required',
                label: 'fontconfig directory',
                path: 'resources/poppler/linux-x64/etc/fonts',
                type: 'directory',
            },
            {
                kind: 'required',
                label: 'fontconfig configuration',
                path: 'resources/poppler/linux-x64/etc/fonts/fonts.conf',
                type: 'file',
            },
        ]));
        expect(verifyScript).toContain('nativeResourceManifestCli.ts packaged-entries "$platform_arch"');
        expect(verifyScript).toContain('check_dir "$entry_path" "$entry_label"');
        expect(verifyScript).toContain('check_file "$entry_path" "$entry_label"');
    });

    it('builds Linux unpaper against the pinned minimal FFmpeg closure', async () => {
        const bundleScript = await readFile(resolve(process.cwd(), 'scripts/bundle-tools-linux.sh'), 'utf8');

        expect(bundleScript).not.toMatch(/^\s*unpaper \\$/mu);
        expect(bundleScript).toContain('build-minimal-ffmpeg-for-unpaper.sh');
        expect(bundleScript).toContain('Unexpected video-codec closure leaked into the Linux unpaper bundle');
        expect(bundleScript).toContain('for required_av_library in libavcodec libavformat libavutil');
    });
});
