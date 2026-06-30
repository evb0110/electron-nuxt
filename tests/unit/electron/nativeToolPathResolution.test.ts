import path from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { resolvePdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { getNativeToolBinaryPath } from '@electron/native-tools/getNativeToolBinaryPath';
import {
    getNativeResourcesBaseCandidates,
    resolveNativeResourcesBase,
} from '@electron/native-tools/resolveNativeResourcesBase';
import {
    getNativeToolPathCandidates,
    resolveNativeToolPath,
} from '@electron/native-tools/resolveNativeToolPath';
import {
    getPageProcessorBinaryName,
    getPageProcessorBinaryRelativePath,
    getPageProcessorPathCandidates,
    resolvePageProcessorPath,
} from '@electron/native-tools/pageProcessorPath';

const baseOptions = {
    binaryName: 'evb-pdf-page-ops.exe',
    crateName: 'pdf-page-ops',
    currentDir: '/repo/electron/features/page-ops/main',
    isPackaged: false,
    platformArch: 'win32-arm64',
    projectRoot: '/repo',
    resourcesBase: '/repo/resources',
};

vi.mock('electron', () => ({app: {isPackaged: false}}));

describe('native resource base resolution', () => {
    it('probes cwd resources before module-relative resources directories', () => {
        expect(getNativeResourcesBaseCandidates('/repo/dist-electron', '/worktree')).toEqual([
            path.join('/worktree', 'resources'),
            path.join('/repo', 'resources'),
            path.join('/', 'resources'),
            path.join('/', 'resources'),
        ]);
    });

    it('resolves a generic native resource root without requiring OCR resources', () => {
        expect(resolveNativeResourcesBase('/repo/dist-electron', false, {
            cwd: '/worktree',
            exists: candidate => candidate === path.join('/repo', 'resources', 'qpdf'),
        })).toBe(path.join('/repo', 'resources'));
    });

    it('keeps packaged resources on Electron resourcesPath', () => {
        expect(resolveNativeResourcesBase('/app/Contents/Resources/app.asar/dist-electron', true, {resourcesPath: '/app/Contents/Resources'})).toBe('/app/Contents/Resources');
    });
});

describe('PDF native tool path boundary', () => {
    it('resolves Poppler and QPDF paths from the native tools base', () => {
        const popplerBase = path.join('/repo/resources/poppler/darwin-arm64');
        const existingPaths = new Set([
            path.join(popplerBase, 'bin', 'pdftoppm'),
            path.join(popplerBase, 'bin', 'pdftotext'),
            path.join(popplerBase, 'bin', 'pdfimages'),
            path.join(popplerBase, 'share', 'poppler'),
            path.join(popplerBase, 'etc', 'fonts'),
            path.join('/repo/resources/qpdf/darwin-arm64', 'bin', 'qpdf'),
        ]);

        expect(resolvePdfNativeToolPaths({
            exists: candidate => existingPaths.has(candidate),
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platform: 'darwin',
            platformArch: 'darwin-arm64',
        })).toEqual({
            pdftoppm: path.join(popplerBase, 'bin', 'pdftoppm'),
            pdftotext: path.join(popplerBase, 'bin', 'pdftotext'),
            pdfimages: path.join(popplerBase, 'bin', 'pdfimages'),
            popplerDataDir: path.join(popplerBase, 'share', 'poppler'),
            popplerFontConfigDir: path.join(popplerBase, 'etc', 'fonts'),
            qpdf: path.join('/repo/resources/qpdf/darwin-arm64', 'bin', 'qpdf'),
        });
    });

    it('keeps pdfimages and Poppler runtime directories optional', () => {
        expect(resolvePdfNativeToolPaths({
            exists: () => false,
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platform: 'linux',
            platformArch: 'linux-x64',
        })).toEqual({
            pdftoppm: 'pdftoppm',
            pdftotext: 'pdftotext',
            qpdf: 'qpdf',
        });
    });
});

describe('native tool binary path primitives', () => {
    it('uses bundled binaries before dev system fallbacks', () => {
        expect(getNativeToolBinaryPath({
            dir: '/repo/resources/qpdf/darwin-arm64',
            exists: candidate => candidate === path.join('/repo/resources/qpdf/darwin-arm64', 'bin', 'qpdf'),
            isPackaged: false,
            name: 'qpdf',
            platform: 'darwin',
        })).toBe(path.join('/repo/resources/qpdf/darwin-arm64', 'bin', 'qpdf'));
    });

    it('keeps the existing macOS Homebrew fallback for development builds', () => {
        expect(getNativeToolBinaryPath({
            dir: '/repo/resources/qpdf/darwin-arm64',
            exists: candidate => candidate === path.join('/opt/homebrew/bin', 'qpdf'),
            isPackaged: false,
            name: 'qpdf',
            platform: 'darwin',
        })).toBe(path.join('/opt/homebrew/bin', 'qpdf'));
    });

    it('returns the bundled path for required packaged tools even before the file exists', () => {
        expect(getNativeToolBinaryPath({
            dir: '/app/Contents/MacOS/native-tools/qpdf/darwin-arm64',
            exists: () => false,
            isPackaged: true,
            name: 'qpdf',
            platform: 'darwin',
        })).toBe(path.join('/app/Contents/MacOS/native-tools/qpdf/darwin-arm64', 'bin', 'qpdf'));
    });

    it('keeps optional missing tools empty and Windows executables suffixed', () => {
        expect(getNativeToolBinaryPath({
            dir: '/repo/resources/tesseract/win32-x64',
            exists: () => false,
            isPackaged: false,
            name: 'unpaper',
            optional: true,
            platform: 'win32',
        })).toBe('');

        expect(getNativeToolBinaryPath({
            dir: '/repo/resources/qpdf/win32-x64',
            exists: candidate => candidate === path.join('/repo/resources/qpdf/win32-x64', 'bin', 'qpdf.exe'),
            isPackaged: false,
            name: 'qpdf',
            platform: 'win32',
        })).toBe(path.join('/repo/resources/qpdf/win32-x64', 'bin', 'qpdf.exe'));
    });
});

describe('native tool path resolution', () => {
    it('probes packaged resources, staged dev binaries, cross targets, and host release output', () => {
        expect(getNativeToolPathCandidates(baseOptions)).toEqual([
            path.join('/repo/resources', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe'),
            path.join('/repo', '.tmp', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe'),
            path.join('/repo', 'native', 'pdf-page-ops', 'target', 'aarch64-pc-windows-msvc', 'release', 'evb-pdf-page-ops.exe'),
            path.join('/repo', 'native', 'pdf-page-ops', 'target', 'release', 'evb-pdf-page-ops.exe'),
        ]);
    });

    it('uses the launchable Contents/MacOS/native-tools root for packaged macOS tools', () => {
        expect(getNativeToolPathCandidates({
            binaryName: 'evb-pdf-page-ops',
            crateName: 'pdf-page-ops',
            currentDir: '/app/Contents/Resources/app.asar/dist-electron',
            isPackaged: true,
            platformArch: 'darwin-arm64',
            projectRoot: '/repo',
            resourcesBase: '/app/Contents/Resources',
        })[0]).toBe(path.join(
            '/app/Contents/MacOS/native-tools',
            'pdf-page-ops',
            'darwin-arm64',
            'bin',
            'evb-pdf-page-ops',
        ));
    });

    it('prefers the override path when it exists', () => {
        expect(resolveNativeToolPath({
            ...baseOptions,
            envOverridePath: '/custom/evb-pdf-page-ops.exe',
            exists: candidate => candidate === '/custom/evb-pdf-page-ops.exe',
        })).toBe('/custom/evb-pdf-page-ops.exe');
    });

    it('falls through to the staged dev binary before raw Cargo outputs', () => {
        const stagedPath = path.join('/repo', '.tmp', 'pdf-page-ops', 'win32-arm64', 'bin', 'evb-pdf-page-ops.exe');
        const crossTargetPath = path.join('/repo', 'native', 'pdf-page-ops', 'target', 'aarch64-pc-windows-msvc', 'release', 'evb-pdf-page-ops.exe');

        expect(resolveNativeToolPath({
            ...baseOptions,
            exists: candidate => candidate === stagedPath || candidate === crossTargetPath,
        })).toBe(stagedPath);
    });

    it('supports nested non-Rust binary layouts without Cargo fallbacks', () => {
        expect(getNativeToolPathCandidates({
            ...baseOptions,
            binaryName: 'page-processor.exe',
            binaryRelativePath: [
                'bin',
                'page-processor',
                'page-processor.exe',
            ],
            crateName: 'page-processing',
            includeRustTargetCandidates: false,
        })).toEqual([
            path.join('/repo/resources', 'page-processing', 'win32-arm64', 'bin', 'page-processor', 'page-processor.exe'),
            path.join('/repo', '.tmp', 'page-processing', 'win32-arm64', 'bin', 'page-processor', 'page-processor.exe'),
        ]);
    });
});

describe('page-processor path resolution', () => {
    it('uses the PyInstaller onedir binary layout under resource and staged dev roots', () => {
        expect(getPageProcessorPathCandidates({
            currentDir: '/repo/electron/native-tools',
            isPackaged: true,
            platformArch: 'win32-arm64',
            projectRoot: '/repo',
            resourcesBase: '/app/resources',
        })).toEqual([
            path.join('/app/resources', 'page-processing', 'win32-arm64', 'bin', 'page-processor', 'page-processor.exe'),
            path.join('/repo', '.tmp', 'page-processing', 'win32-arm64', 'bin', 'page-processor', 'page-processor.exe'),
        ]);
    });

    it('keeps the nested binary relative path explicit for callers that need packaging checks', () => {
        expect(getPageProcessorBinaryRelativePath('page-processor.exe')).toEqual([
            'bin',
            'page-processor',
            'page-processor.exe',
        ]);
    });

    it('resolves the first existing nested page-processor candidate', () => {
        const resourcePath = path.join('/repo/resources', 'page-processing', 'darwin-arm64', 'bin', 'page-processor', 'page-processor');
        const stagedPath = path.join('/repo', '.tmp', 'page-processing', 'darwin-arm64', 'bin', 'page-processor', 'page-processor');

        expect(resolvePageProcessorPath({
            currentDir: '/repo/electron/native-tools',
            isPackaged: false,
            platform: 'darwin',
            platformArch: 'darwin-arm64',
            projectRoot: '/repo',
            resourcesBase: '/repo/resources',
            exists: candidate => candidate === resourcePath || candidate === stagedPath,
        })).toBe(resourcePath);
    });

    it('supports the existing EVB_PAGE_PROCESSOR override and the native-tool PATH override name', () => {
        expect(resolvePageProcessorPath({
            currentDir: '/repo/electron/native-tools',
            env: {
                EVB_PAGE_PROCESSOR: '/old/page-processor',
                EVB_PAGE_PROCESSOR_PATH: '/new/page-processor',
            },
            isPackaged: false,
            platform: 'darwin',
            platformArch: 'darwin-arm64',
            projectRoot: '/repo',
            resourcesBase: '/repo/resources',
            exists: candidate => candidate === '/new/page-processor',
        })).toBe('/new/page-processor');

        expect(resolvePageProcessorPath({
            currentDir: '/repo/electron/native-tools',
            env: {EVB_PAGE_PROCESSOR: '/old/page-processor'},
            isPackaged: false,
            platform: 'darwin',
            platformArch: 'darwin-arm64',
            projectRoot: '/repo',
            resourcesBase: '/repo/resources',
            exists: candidate => candidate === '/old/page-processor',
        })).toBe('/old/page-processor');
    });

    it('uses the platform arch tag to choose the Windows executable name', () => {
        expect(getPageProcessorBinaryName('win32')).toBe('page-processor.exe');
        expect(getPageProcessorPathCandidates({
            currentDir: '/repo/electron/native-tools',
            isPackaged: false,
            platformArch: 'win32-x64',
            projectRoot: '/repo',
            resourcesBase: '/repo/resources',
        })[0]).toBe(path.join(
            '/repo/resources',
            'page-processing',
            'win32-x64',
            'bin',
            'page-processor',
            'page-processor.exe',
        ));
    });
});
