const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const SUPPORTED_EXTRA_RESOURCE_PLATFORMS = new Set([
    'darwin',
    'linux',
    'win32',
]);
const REQUIRED_GLOBAL_EXTRA_RESOURCES = [
    {
        label: 'tessdata directory',
        sourceSegments: [
            'resources',
            'tesseract',
            'tessdata',
        ],
        stagedSegments: [
            'tesseract',
            'tessdata',
        ],
        type: 'directory',
    },
    {
        label: 'application resource icon',
        sourceSegments: [
            'resources',
            'icon.png',
        ],
        stagedSegments: ['icon.png'],
        type: 'file',
    },
];
const REQUIRED_PLATFORM_EXTRA_RESOURCE_ROOTS = [
    {
        label: 'Tesseract native tools',
        sourceRootSegments: [
            'resources',
            'tesseract',
        ],
        stagedRootSegments: ['tesseract'],
    },
    {
        label: 'Poppler native tools',
        sourceRootSegments: [
            'resources',
            'poppler',
        ],
        stagedRootSegments: ['poppler'],
    },
    {
        label: 'qpdf native tools',
        sourceRootSegments: [
            'resources',
            'qpdf',
        ],
        stagedRootSegments: ['qpdf'],
    },
    {
        label: 'DjVuLibre native tools',
        sourceRootSegments: [
            'resources',
            'djvulibre',
        ],
        stagedRootSegments: ['djvulibre'],
    },
    {
        label: 'PDF image combine native tool',
        sourceRootSegments: [
            '.tmp',
            'pdf-image-combine',
        ],
        stagedRootSegments: ['pdf-image-combine'],
    },
    {
        label: 'PDF page ops native tool',
        sourceRootSegments: [
            '.tmp',
            'pdf-page-ops',
        ],
        stagedRootSegments: ['pdf-page-ops'],
    },
    {
        label: 'PDF search native tool',
        sourceRootSegments: [
            '.tmp',
            'pdf-search',
        ],
        stagedRootSegments: ['pdf-search'],
    },
];

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

function platformArchTagForContext(context) {
    const platform = context.electronPlatformName;
    if (!SUPPORTED_EXTRA_RESOURCE_PLATFORMS.has(platform)) {
        throw new Error(`[afterPack] Unsupported required extraResources platform: ${platform}`);
    }

    const arch = archName(context.arch);
    if (arch === null) {
        throw new Error(`[afterPack] Unsupported required extraResources arch: ${context.arch}`);
    }

    return `${platform}-${arch}`;
}

function requiredExtraResourcesForContext(context, {
    projectRoot: root = projectRoot,
    resourcesDir = resourcesDirForContext(context),
} = {}) {
    const tag = platformArchTagForContext(context);
    const entries = REQUIRED_GLOBAL_EXTRA_RESOURCES.map(entry => ({
        label: entry.label,
        sourcePath: path.join(root, ...entry.sourceSegments),
        stagedPath: path.join(resourcesDir, ...entry.stagedSegments),
        tag,
        type: entry.type,
    }));

    for (const entry of REQUIRED_PLATFORM_EXTRA_RESOURCE_ROOTS) {
        entries.push({
            label: `${entry.label} (${tag})`,
            sourcePath: path.join(root, ...entry.sourceRootSegments, tag),
            stagedPath: path.join(resourcesDir, ...entry.stagedRootSegments, tag),
            tag,
            type: 'directory',
        });
    }

    return entries;
}

function hasExpectedPathType(filePath, type) {
    try {
        const stat = fs.statSync(filePath);
        return type === 'file'
            ? stat.isFile()
            : stat.isDirectory();
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return false;
        }

        throw error;
    }
}

function assertRequiredExtraResources(context, options) {
    const missing = [];
    const entries = requiredExtraResourcesForContext(context, options);

    for (const entry of entries) {
        if (!hasExpectedPathType(entry.sourcePath, entry.type)) {
            missing.push(`source ${entry.label}: ${entry.sourcePath}`);
            continue;
        }

        if (!hasExpectedPathType(entry.stagedPath, entry.type)) {
            missing.push(`packaged ${entry.label}: ${entry.stagedPath}`);
        }
    }

    if (missing.length > 0) {
        throw new Error([
            `[afterPack] Missing required electron-builder extraResources for ${entries[0].tag}:`,
            ...missing.map(item => `- ${item}`),
            'Run the platform native-tool build steps before packaging and verify electron-builder.yml extraResources.',
        ].join('\n'));
    }
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
    assertRequiredExtraResources(context);
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
exports.assertRequiredExtraResources = assertRequiredExtraResources;
exports.requiredExtraResourcesForContext = requiredExtraResourcesForContext;
