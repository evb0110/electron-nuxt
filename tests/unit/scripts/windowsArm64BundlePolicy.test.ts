import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const bundleToolsWindowsPath = resolve(process.cwd(), 'scripts/bundle-tools-windows.sh');
const sourceMatrixPath = resolve(process.cwd(), 'scripts/check-native-tools-source-matrix.sh');

describe('Windows ARM64 native bundle policy', () => {
    it('excludes MSYS2 training DLLs from ARM64 runtime bundles', () => {
        const bundlerSource = readFileSync(bundleToolsWindowsPath, 'utf8');

        expect(bundlerSource).toContain('MSYS2_ARM64_RUNTIME_DLL_EXCLUDES=(');
        expect(bundlerSource).toContain('libpango_training.dll');
        expect(bundlerSource).toContain('should_exclude_msys2_runtime_dll');
        expect(bundlerSource).toContain('MSYS2_ROOT:-/c/msys64');
        expect(bundlerSource).toContain('Architecture = aarch64');
        expect(bundlerSource).toContain('[clangarm64]');
        expect(bundlerSource).toContain('-Sp --noconfirm "${packages[@]}"');
        expect(bundlerSource).toContain('MSYS2 ARM64 bundle tool not found');

        for (const destination of [
            '$TESSERACT_DIR/bin',
            '$POPPLER_DIR/bin',
            '$QPDF_DIR/bin',
            '$DJVU_DIR/bin',
        ]) {
            expect(bundlerSource).toContain(`copy_msys2_runtime_dlls "$arm64_bin" "${destination}"`);
            expect(bundlerSource).not.toContain(`cp "$arm64_bin/"*.dll "${destination}/"`);
        }
    });

    it('keeps the resource matrix gate checking the Windows ARM64 DLL policy', () => {
        const sourceMatrix = readFileSync(sourceMatrixPath, 'utf8');

        expect(sourceMatrix).toContain('check_windows_arm64_runtime_dll_policy');
        expect(sourceMatrix).toContain('libpango_training.dll');
        expect(sourceMatrix).toContain('ARM64 Windows bundler must not blindly copy MSYS2 DLLs');
    });
});
