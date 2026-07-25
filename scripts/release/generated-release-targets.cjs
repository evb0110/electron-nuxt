'use strict';
const manifest = JSON.parse(String.raw`{
    "electronBuilderPlatformKeys": {
        "darwin": "mac",
        "linux": "linux",
        "win32": "win"
    },
    "families": [
        {
            "binaryName": null,
            "id": "tesseract",
            "label": "Tesseract native tools",
            "packagedEntries": [
                {
                    "id": "tesseract",
                    "label": "tesseract binary",
                    "pathSegments": [
                        "bin",
                        "tesseract{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "unpaper",
                    "label": "unpaper binary",
                    "pathSegments": [
                        "bin",
                        "unpaper{exeSuffix}"
                    ],
                    "platforms": [
                        "darwin",
                        "linux"
                    ],
                    "skip": {
                        "win32": "not bundled on Windows"
                    },
                    "type": "file"
                }
            ],
            "protocolVersion": null,
            "sourceRootSegments": [
                "resources",
                "tesseract"
            ],
            "stagedRootSegments": [
                "tesseract"
            ]
        },
        {
            "binaryName": null,
            "id": "poppler",
            "label": "Poppler native tools",
            "packagedEntries": [
                {
                    "id": "pdfinfo",
                    "label": "pdfinfo binary",
                    "pathSegments": [
                        "bin",
                        "pdfinfo{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "pdftoppm",
                    "label": "pdftoppm binary",
                    "pathSegments": [
                        "bin",
                        "pdftoppm{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "pdftotext",
                    "label": "pdftotext binary",
                    "pathSegments": [
                        "bin",
                        "pdftotext{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "pdftocairo",
                    "label": "pdftocairo binary",
                    "pathSegments": [
                        "bin",
                        "pdftocairo{exeSuffix}"
                    ],
                    "platforms": [
                        "win32"
                    ],
                    "type": "file"
                },
                {
                    "id": "poppler-data",
                    "label": "poppler data directory",
                    "pathSegments": [
                        "share",
                        "poppler"
                    ],
                    "platforms": [
                        "linux",
                        "win32"
                    ],
                    "type": "directory"
                },
                {
                    "id": "fontconfig-directory",
                    "label": "fontconfig directory",
                    "pathSegments": [
                        "etc",
                        "fonts"
                    ],
                    "platforms": [
                        "linux"
                    ],
                    "type": "directory"
                },
                {
                    "id": "fontconfig-configuration",
                    "label": "fontconfig configuration",
                    "pathSegments": [
                        "etc",
                        "fonts",
                        "fonts.conf"
                    ],
                    "platforms": [
                        "linux"
                    ],
                    "type": "file"
                }
            ],
            "packageFiltersByPlatform": {
                "win32": [
                    "**/*",
                    "!share/poppler/CMakeLists.txt",
                    "!share/poppler/Makefile",
                    "!share/poppler/README",
                    "!share/poppler/poppler-data.pc",
                    "!share/poppler/poppler-data.pc.in"
                ]
            },
            "protocolVersion": null,
            "sourceRootSegments": [
                "resources",
                "poppler"
            ],
            "stagedRootSegments": [
                "poppler"
            ]
        },
        {
            "binaryName": null,
            "id": "qpdf",
            "label": "qpdf native tools",
            "packagedEntries": [
                {
                    "id": "qpdf",
                    "label": "qpdf binary",
                    "pathSegments": [
                        "bin",
                        "qpdf{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolVersion": null,
            "sourceRootSegments": [
                "resources",
                "qpdf"
            ],
            "stagedRootSegments": [
                "qpdf"
            ]
        },
        {
            "binaryName": null,
            "id": "djvulibre",
            "label": "DjVuLibre native tools",
            "packagedEntries": [
                {
                    "id": "ddjvu",
                    "label": "ddjvu binary",
                    "pathSegments": [
                        "bin",
                        "ddjvu{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "djvused",
                    "label": "djvused binary",
                    "pathSegments": [
                        "bin",
                        "djvused{exeSuffix}"
                    ],
                    "type": "file"
                },
                {
                    "id": "djvudump",
                    "label": "djvudump binary",
                    "pathSegments": [
                        "bin",
                        "djvudump{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolVersion": null,
            "sourceRootSegments": [
                "resources",
                "djvulibre"
            ],
            "stagedRootSegments": [
                "djvulibre"
            ]
        },
        {
            "binaryName": "evb-pdf-image-combine",
            "id": "pdf-image-combine",
            "label": "PDF image combine native tool",
            "packagedEntries": [
                {
                    "id": "evb-pdf-image-combine",
                    "label": "evb-pdf-image-combine binary",
                    "pathSegments": [
                        "bin",
                        "evb-pdf-image-combine{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolVersion": 4,
            "sourceRootSegments": [
                ".tmp",
                "pdf-image-combine"
            ],
            "stagedRootSegments": [
                "pdf-image-combine"
            ]
        },
        {
            "binaryName": "evb-pdf-page-ops",
            "id": "pdf-page-ops",
            "label": "PDF page ops native tool",
            "packagedEntries": [
                {
                    "id": "evb-pdf-page-ops",
                    "label": "evb-pdf-page-ops binary",
                    "pathSegments": [
                        "bin",
                        "evb-pdf-page-ops{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolVersion": 1,
            "sourceRootSegments": [
                ".tmp",
                "pdf-page-ops"
            ],
            "stagedRootSegments": [
                "pdf-page-ops"
            ]
        },
        {
            "binaryName": "evb-pdf-search",
            "id": "pdf-search",
            "label": "PDF search native tool",
            "packagedEntries": [
                {
                    "id": "evb-pdf-search",
                    "label": "evb-pdf-search binary",
                    "pathSegments": [
                        "bin",
                        "evb-pdf-search{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolVersion": 1,
            "sourceRootSegments": [
                ".tmp",
                "pdf-search"
            ],
            "stagedRootSegments": [
                "pdf-search"
            ]
        },
        {
            "binaryName": "evb-scan-cleanup",
            "id": "scan-cleanup",
            "label": "Scan cleanup native tool",
            "packagedEntries": [
                {
                    "id": "evb-scan-cleanup",
                    "label": "evb-scan-cleanup binary",
                    "pathSegments": [
                        "bin",
                        "evb-scan-cleanup{exeSuffix}"
                    ],
                    "type": "file"
                }
            ],
            "protocolVersion": 3,
            "sourceRootSegments": [
                ".tmp",
                "scan-cleanup"
            ],
            "stagedRootSegments": [
                "scan-cleanup"
            ]
        }
    ],
    "globalResources": [
        {
            "filters": [
                "eng.traineddata",
                "rus.traineddata"
            ],
            "id": "tessdata",
            "label": "tessdata directory",
            "sourceSegments": [
                "resources",
                "tesseract",
                "tessdata"
            ],
            "stagedSegments": [
                "tesseract",
                "tessdata"
            ],
            "type": "directory"
        },
        {
            "id": "application-resource-icon",
            "label": "application resource icon",
            "sourceSegments": [
                "resources",
                "icon.png"
            ],
            "stagedSegments": [
                "icon.png"
            ],
            "type": "file"
        }
    ],
    "platformArches": [
        "darwin-x64",
        "darwin-arm64",
        "linux-x64",
        "linux-arm64",
        "win32-x64",
        "win32-arm64"
    ],
    "schemaVersion": 1,
    "signing": {
        "entitlementsPathSegments": [
            "build",
            "entitlements.mac.plist"
        ],
        "executableRoots": [
            [
                "tesseract"
            ],
            [
                "poppler"
            ],
            [
                "qpdf"
            ],
            [
                "djvulibre"
            ],
            [
                "pdf-image-combine"
            ],
            [
                "pdf-page-ops"
            ],
            [
                "pdf-search"
            ],
            [
                "scan-cleanup"
            ]
        ],
        "platforms": [
            "darwin"
        ]
    }
}`);
function assertManifest(value) {
    const record = item => item && typeof item === 'object' && !Array.isArray(item);
    const strings = item => Array.isArray(item) && item.length > 0 && item.every(part => typeof part === 'string' && part.length > 0);
    const paths = item => strings(item) && item.every(part => part !== '.' && part !== '..' && !part.startsWith('/'));
    if (!record(value) || value.schemaVersion !== 1 || !strings(value.platformArches)) throw new Error('[release manifest] Invalid root');
    if (!record(value.electronBuilderPlatformKeys) || !Array.isArray(value.families) || value.families.length === 0) throw new Error('[release manifest] Invalid targets');
    for (const family of value.families) {
        if (!record(family) || !paths(family.sourceRootSegments) || !paths(family.stagedRootSegments) || !Array.isArray(family.packagedEntries) || family.packagedEntries.length === 0) throw new Error('[release manifest] Invalid family');
        for (const entry of family.packagedEntries) {
            if (!record(entry) || !paths(entry.pathSegments) || ![
                'directory',
                'file',
            ].includes(entry.type)) throw new Error('[release manifest] Invalid packaged entry');
        }
    }
    if (!Array.isArray(value.globalResources) || value.globalResources.length === 0) throw new Error('[release manifest] globalResources must be a non-empty array');
    for (const resource of value.globalResources) {
        if (!record(resource) || !paths(resource.sourceSegments) || !paths(resource.stagedSegments)) throw new Error('[release manifest] Invalid global resource');
    }
    if (!record(value.signing) || !strings(value.signing.platforms) || !paths(value.signing.entitlementsPathSegments) || !Array.isArray(value.signing.executableRoots) || !value.signing.executableRoots.every(paths)) throw new Error('[release manifest] Invalid signing inputs');
    return value;
}
function renderPackagedEntries(tag) {
    const platform = tag.slice(0, tag.lastIndexOf('-'));
    if (!manifest.platformArches.includes(tag)) {
        throw new Error(`[release manifest] Unsupported platform-arch: ${tag}`);
    }
    const suffix = platform === 'win32' ? '.exe' : '';
    const lines = manifest.families.flatMap(family => family.packagedEntries
        .filter(entry => !entry.platforms || entry.platforms.includes(platform))
        .map(entry => [
            'native',
            family.stagedRootSegments.join('/'),
            entry.pathSegments.join('/').replaceAll('{exeSuffix}', suffix),
            entry.type,
            entry.label,
            entry.id,
        ].join('\t')));
    lines.push(...manifest.globalResources.map(resource => [
        'global',
        '',
        resource.stagedSegments.join('/'),
        resource.type,
        resource.label,
        resource.id,
    ].join('\t')));
    return lines.join('\n');
}
module.exports = {
    manifest: assertManifest(manifest),
    renderPackagedEntries,
    validateReleaseTargetManifest: assertManifest,
};
