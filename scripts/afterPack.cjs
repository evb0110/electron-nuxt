const fs = require('fs');
const path = require('path');

function archName(arch) {
    switch (arch) {
        case 1:
        case 'x64':
            return 'x64';
        case 3:
        case 'arm64':
            return 'arm64';
        default:
            return null;
    }
}

function resourcesDirForContext(context) {
    if (context.packager && typeof context.packager.getResourcesDir === 'function') {
        return context.packager.getResourcesDir(context.appOutDir);
    }

    if (context.electronPlatformName === 'darwin') {
        const appName = context.packager.appInfo.productFilename;
        return path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources');
    }

    return path.join(context.appOutDir, 'resources');
}

function appPathForContext(context) {
    const appName = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${appName}.app`);
}

function nativeToolsDirForContext(context) {
    if (context.electronPlatformName === 'darwin') {
        return path.join(appPathForContext(context), 'Contents', 'MacOS', 'native-tools');
    }

    return resourcesDirForContext(context);
}

function isPageProcessingRequired(context) {
    return context.electronPlatformName === 'darwin' && process.env.EVB_INCLUDE_PAGE_PROCESSOR === '1';
}

function shouldCopyPageProcessingResources() {
    return process.env.EVB_INCLUDE_PAGE_PROCESSOR === '1';
}

function copyPageProcessingResources(context) {
    if (!shouldCopyPageProcessingResources()) {
        return;
    }

    const arch = archName(context.arch);
    if (arch === null) {
        if (isPageProcessingRequired(context)) {
            throw new Error(`[afterPack] Unsupported required page-processing arch: ${context.arch}`);
        }
        console.warn('[afterPack] Skipping optional page-processing resources for unsupported arch:', context.arch);
        return;
    }

    const tag = `${context.electronPlatformName}-${arch}`;
    const src = path.resolve(__dirname, '..', 'resources', 'page-processing', tag);
    if (!fs.existsSync(src)) {
        if (isPageProcessingRequired(context)) {
            throw new Error(`[afterPack] Required page-processing resources not found: ${src}`);
        }
        console.log('[afterPack] Optional page-processing resources not found:', src);
        return;
    }

    const dst = path.join(nativeToolsDirForContext(context), 'page-processing', tag);
    fs.rmSync(dst, {
        force: true,
        recursive: true,
    });
    fs.mkdirSync(path.dirname(dst), {recursive: true});
    fs.cpSync(src, dst, {
        recursive: true,
        verbatimSymlinks: true,
    });
    console.log('[afterPack] Copied page-processing resources:', dst);
}

function removeEmptyDir(dir) {
    try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
        }
    } catch {
        // Best effort cleanup only; the moved payload is what matters.
    }
}

function moveMacNativeToolResources(context) {
    if (context.electronPlatformName !== 'darwin') {
        return;
    }

    const arch = archName(context.arch);
    if (arch === null) {
        throw new Error(`[afterPack] Unsupported macOS native-tool arch: ${context.arch}`);
    }

    const tag = `darwin-${arch}`;
    const resourcesDir = resourcesDirForContext(context);
    const nativeToolsDir = nativeToolsDirForContext(context);
    const toolRoots = [
        'djvulibre',
        'pdf-image-combine',
        'pdf-page-ops',
        'pdf-search',
        'poppler',
        'qpdf',
        'tesseract',
    ];

    for (const toolRoot of toolRoots) {
        const src = path.join(resourcesDir, toolRoot, tag);
        if (!fs.existsSync(src)) {
            continue;
        }

        const dst = path.join(nativeToolsDir, toolRoot, tag);
        fs.rmSync(dst, {
            force: true,
            recursive: true,
        });
        fs.mkdirSync(path.dirname(dst), {recursive: true});
        fs.cpSync(src, dst, {
            recursive: true,
            verbatimSymlinks: true,
        });
        fs.rmSync(src, {
            force: true,
            recursive: true,
        });
        removeEmptyDir(path.dirname(src));
        console.log('[afterPack] Moved macOS native tool resources:', dst);
    }
}

exports.default = async function afterPack(context) {
    copyPageProcessingResources(context);
    moveMacNativeToolResources(context);

    if (context.electronPlatformName !== 'darwin') {
        return;
    }

    const src = path.resolve(__dirname, '..', 'resources', 'icon.icns');
    const dst = path.join(appPathForContext(context), 'Contents', 'Resources', 'icon.icns');

    if (!fs.existsSync(src)) {
        console.warn('[afterPack] Source icon not found:', src);
        return;
    }

    fs.copyFileSync(src, dst);
    console.log('[afterPack] Restored original icon.icns (bypassing app-builder alpha corruption)');
};
