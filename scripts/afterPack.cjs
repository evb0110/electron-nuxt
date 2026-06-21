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

    const dst = path.join(resourcesDirForContext(context), 'page-processing', tag);
    fs.rmSync(dst, {
        force: true,
        recursive: true,
    });
    fs.cpSync(src, dst, {
        recursive: true,
        verbatimSymlinks: true,
    });
    console.log('[afterPack] Copied page-processing resources:', dst);
}

exports.default = async function afterPack(context) {
    copyPageProcessingResources(context);

    if (context.electronPlatformName !== 'darwin') {
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const src = path.resolve(__dirname, '..', 'resources', 'icon.icns');
    const dst = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'icon.icns');

    if (!fs.existsSync(src)) {
        console.warn('[afterPack] Source icon not found:', src);
        return;
    }

    fs.copyFileSync(src, dst);
    console.log('[afterPack] Restored original icon.icns (bypassing app-builder alpha corruption)');
};
