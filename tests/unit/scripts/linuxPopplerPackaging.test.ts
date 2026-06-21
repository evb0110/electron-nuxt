import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('linux Poppler packaging', () => {
    it('bundles and verifies Poppler runtime data and fontconfig resources', async () => {
        const bundleScript = await readFile(resolve(process.cwd(), 'scripts/bundle-tools-linux.sh'), 'utf8');
        expect(bundleScript).toContain('cp -a /usr/share/poppler "$POPPLER_DIR/share/"');
        expect(bundleScript).toContain('cp -a /etc/fonts "$POPPLER_DIR/etc/"');
        expect(bundleScript).toContain('verify_dir()');
        expect(bundleScript).toContain('verify_dir "$POPPLER_DIR/share/poppler" "poppler data directory"');
        expect(bundleScript).toContain('verify_dir "$POPPLER_DIR/etc/fonts" "fontconfig directory"');
        expect(bundleScript).toContain('missing_count=$((missing_count + 1))');
        expect(bundleScript).toContain('Error: Bundle verification failed');

        const verifyScript = await readFile(resolve(process.cwd(), 'scripts/verify-packaged-native-tools.sh'), 'utf8');
        expect(verifyScript).toContain('check_dir "$native_tool_root/poppler/$platform_arch/share/poppler" "poppler data directory"');
        expect(verifyScript).toContain('check_dir "$native_tool_root/poppler/$platform_arch/etc/fonts" "fontconfig directory"');
        expect(verifyScript).toContain('check_file "$native_tool_root/poppler/$platform_arch/etc/fonts/fonts.conf" "fontconfig configuration"');
    });
});
