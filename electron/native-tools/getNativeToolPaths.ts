import { existsSync } from 'fs';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import type { App } from 'electron';
import * as electron from 'electron';
import { getNativeToolBinaryPath } from '@electron/native-tools/nativeToolBinaryPath';
import { resolveNativeToolsBase } from '@electron/native-tools/resolveNativeToolsBase';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';

export interface INativeToolPaths {
    pdftoppm: string;
    pdftotext: string;
    pdfimages?: string;
    popplerDataDir?: string;
    popplerFontConfigDir?: string;
    qpdf: string;
    tesseract: string;
    unpaper?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function isElectronAppPackaged() {
    return (electron as {app?: Pick<App, 'isPackaged'>}).app?.isPackaged === true;
}

function getNativeToolsBase(isPackaged: boolean) {
    return resolveNativeToolsBase(__dirname, isPackaged);
}

function getToolBinaryPath(dir: string, name: string, isPackaged: boolean, optional = false) {
    return getNativeToolBinaryPath({
        dir,
        isPackaged,
        name,
        optional,
    });
}

export function getNativeToolPaths(): INativeToolPaths {
    const appIsPackaged = isElectronAppPackaged();
    const platformArch = resolvePlatformArchTag();
    const nativeToolsBase = getNativeToolsBase(appIsPackaged);

    const tesseractDir = join(nativeToolsBase, 'tesseract');
    const tesseractPlatformDir = join(tesseractDir, platformArch);
    const tesseract = getToolBinaryPath(tesseractPlatformDir, 'tesseract', appIsPackaged);
    const unpaper = getToolBinaryPath(tesseractPlatformDir, 'unpaper', appIsPackaged, true) || undefined;
    const popplerDir = join(nativeToolsBase, 'poppler', platformArch);
    const pdftoppm = getToolBinaryPath(popplerDir, 'pdftoppm', appIsPackaged);
    const pdftotext = getToolBinaryPath(popplerDir, 'pdftotext', appIsPackaged);
    const pdfimages = getToolBinaryPath(popplerDir, 'pdfimages', appIsPackaged, true) || undefined;
    const popplerDataDirCandidate = join(popplerDir, 'share', 'poppler');
    const popplerFontConfigDirCandidate = join(popplerDir, 'etc', 'fonts');
    const popplerDataDir = existsSync(popplerDataDirCandidate) ? popplerDataDirCandidate : undefined;
    const popplerFontConfigDir = existsSync(popplerFontConfigDirCandidate) ? popplerFontConfigDirCandidate : undefined;
    const qpdf = getToolBinaryPath(join(nativeToolsBase, 'qpdf', platformArch), 'qpdf', appIsPackaged);

    const paths: INativeToolPaths = {
        tesseract,
        pdftoppm,
        pdftotext,
        qpdf,
    };
    if (pdfimages !== undefined) {
        paths.pdfimages = pdfimages;
    }
    if (popplerDataDir !== undefined) {
        paths.popplerDataDir = popplerDataDir;
    }
    if (popplerFontConfigDir !== undefined) {
        paths.popplerFontConfigDir = popplerFontConfigDir;
    }
    if (unpaper !== undefined) {
        paths.unpaper = unpaper;
    }

    return paths;
}
