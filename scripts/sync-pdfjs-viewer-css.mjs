import {
    copyFile,
    mkdir,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, '..');

const sourceCssPath = path.join(
    projectRoot,
    'node_modules',
    'pdfjs-dist',
    'web',
    'pdf_viewer.css',
);
const sourceImagesDir = path.join(
    projectRoot,
    'node_modules',
    'pdfjs-dist',
    'web',
    'images',
);
const targetCssPath = path.join(
    projectRoot,
    'app',
    'assets',
    'css',
    'vendor',
    'pdfjs-viewer-sanitized.css',
);
const targetImagesDir = path.join(projectRoot, 'public', 'pdfjs', 'images');

const removableRulePatterns = [
    '.dialog.newAltText',
    '#viewsManager',
    '#outerContainer.viewsManager',
];

function parseArgs(args) {
    const parsed = {check: false};

    for (const arg of args) {
        if (arg === '--check') {
            parsed.check = true;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return parsed;
}

function collectBlockRanges(cssText, shouldRemoveBlock) {
    const ranges = [];
    const stack = [{ segmentStart: 0 }];

    let inComment = false;
    let inString = false;
    let stringChar = '';

    for (let index = 0; index < cssText.length; index += 1) {
        const current = cssText[index];
        const next = cssText[index + 1];

        if (inComment) {
            if (current === '*' && next === '/') {
                inComment = false;
                index += 1;
            }
            continue;
        }

        if (inString) {
            if (current === '\\') {
                index += 1;
                continue;
            }
            if (current === stringChar) {
                inString = false;
                stringChar = '';
            }
            continue;
        }

        if (current === '/' && next === '*') {
            inComment = true;
            index += 1;
            continue;
        }

        if (current === '"' || current === '\'') {
            inString = true;
            stringChar = current;
            continue;
        }

        if (current === '{') {
            const parent = stack[stack.length - 1];
            const preludeStart = parent.segmentStart;
            stack.push({
                segmentStart: index + 1,
                preludeStart,
                braceStart: index,
                prelude: cssText.slice(preludeStart, index),
            });
            continue;
        }

        if (current !== '}' || stack.length === 1) {
            continue;
        }

        const block = stack.pop();
        const blockEnd = index + 1;
        const body = cssText.slice(block.braceStart + 1, index);
        const prelude = block.prelude.trim();
        if (shouldRemoveBlock(prelude, body)) {
            ranges.push({
                start: block.preludeStart,
                end: blockEnd,
            });
        }

        const parent = stack[stack.length - 1];
        parent.segmentStart = blockEnd;
    }

    return ranges;
}

function applyRanges(cssText, ranges) {
    if (ranges.length === 0) {
        return cssText;
    }

    const sorted = ranges.sort((a, b) => b.start - a.start);
    let output = cssText;
    for (const range of sorted) {
        output = `${output.slice(0, range.start)}\n${output.slice(range.end)}`;
    }
    return output;
}

export function removeUnusedUiBlocks(cssText) {
    const matchedPatterns = new Set();
    const removableRules = collectBlockRanges(
        cssText,
        (prelude) => {
            const matchedPattern = removableRulePatterns.find(pattern => prelude.includes(pattern));
            if (matchedPattern === undefined) {
                return false;
            }

            matchedPatterns.add(matchedPattern);
            return true;
        },
    );
    const missingPatterns = removableRulePatterns.filter(pattern => !matchedPatterns.has(pattern));
    if (missingPatterns.length > 0) {
        throw new Error(
            'PDF.js viewer CSS removal pattern(s) no longer match upstream css: '
            + missingPatterns.join(', '),
        );
    }

    let sanitized = applyRanges(cssText, removableRules);

    while (true) {
        const emptyAtRules = collectBlockRanges(sanitized, (prelude, body) => {
            if (!prelude.startsWith('@')) {
                return false;
            }

            const compactBody = body
                .replace(/\/\*[\s\S]*?\*\//gu, '')
                .trim();
            return compactBody.length === 0;
        });

        if (emptyAtRules.length === 0) {
            break;
        }

        sanitized = applyRanges(sanitized, emptyAtRules);
    }

    return sanitized;
}

export function rewriteImageUrls(cssText, sourceImageNames) {
    const availableImageNames = new Set(sourceImageNames);

    let sanitized = cssText.replace(
        /url\((['"]?)images\/([^)"']+)\1\)/gu,
        (fullMatch, _quote, rawName) => {
            const imageName = String(rawName).trim();
            if (!availableImageNames.has(imageName)) {
                return '__PDFJS_MISSING_ASSET__';
            }

            return `url('/pdfjs/images/${imageName}')`;
        },
    );

    sanitized = sanitized.replace(
        /^[ \t]*[^{}\n]+:\s*__PDFJS_MISSING_ASSET__[^;]*;\s*$/gmu,
        '',
    );

    return sanitized;
}

export function collectReferencedImages(cssText) {
    const images = new Set();
    for (const match of cssText.matchAll(/\/pdfjs\/images\/([^)'"?\s]+)/gu)) {
        images.add(match[1]);
    }
    return Array.from(images).sort((a, b) => a.localeCompare(b));
}

export function normalizeWhitespace(cssText) {
    return cssText
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .concat('\n');
}

async function syncImages(imageNames) {
    await rm(targetImagesDir, {
        recursive: true,
        force: true,
    });
    await mkdir(targetImagesDir, { recursive: true });

    await Promise.all(imageNames.map(async (imageName) => {
        const sourcePath = path.join(sourceImagesDir, imageName);
        const targetPath = path.join(targetImagesDir, imageName);
        await copyFile(sourcePath, targetPath);
    }));
}

async function readTargetImageNames() {
    try {
        return (await readdir(targetImagesDir))
            .filter(imageName => !imageName.startsWith('.'))
            .sort((left, right) => left.localeCompare(right));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }

        throw error;
    }
}

function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function assertImageFreshness(referencedImages) {
    const targetImageNames = await readTargetImageNames();
    const drifted = [];

    if (!arraysEqual(targetImageNames, referencedImages)) {
        drifted.push(`public/pdfjs/images image list (expected ${referencedImages.join(', ') || '<none>'}; received ${targetImageNames.join(', ') || '<none>'})`);
    }

    await Promise.all(referencedImages.map(async (imageName) => {
        const [
            sourceImage,
            targetImage,
        ] = await Promise.all([
            readFile(path.join(sourceImagesDir, imageName)),
            readFile(path.join(targetImagesDir, imageName)).catch((error) => {
                if (error?.code === 'ENOENT') {
                    return null;
                }
                throw error;
            }),
        ]);

        if (targetImage === null || Buffer.compare(sourceImage, targetImage) !== 0) {
            drifted.push(`public/pdfjs/images/${imageName}`);
        }
    }));

    return drifted;
}

async function assertFreshness({
    normalizedCss,
    referencedImages,
}) {
    const drifted = [];
    const targetCss = await readFile(targetCssPath, 'utf8').catch((error) => {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    });

    if (targetCss !== normalizedCss) {
        drifted.push(path.relative(projectRoot, targetCssPath));
    }

    drifted.push(...await assertImageFreshness(referencedImages));

    if (drifted.length > 0) {
        throw new Error([
            'PDF.js viewer CSS assets are out of sync:',
            ...drifted.map(file => `  ${file}`),
            'Run `pnpm run copy:pdfjs` and commit the regenerated assets.',
        ].join('\n'));
    }
}

export async function createPdfjsViewerCssSyncPlan() {
    const [
        sourceCss,
        sourceImages,
    ] = await Promise.all([
        readFile(sourceCssPath, 'utf8'),
        readdir(sourceImagesDir),
    ]);

    const withoutUnusedUi = removeUnusedUiBlocks(sourceCss);
    const rewrittenUrls = rewriteImageUrls(withoutUnusedUi, sourceImages);
    const withoutEmptyRules = applyRanges(
        rewrittenUrls,
        collectBlockRanges(rewrittenUrls, (prelude, body) => (
            !prelude.startsWith('@')
            && body.replace(/\/\*[\s\S]*?\*\//gu, '').trim().length === 0
        )),
    );
    const normalizedCss = normalizeWhitespace(
        `/* Auto-generated by scripts/sync-pdfjs-viewer-css.mjs. */\n\n${withoutEmptyRules}`,
    );
    const referencedImages = collectReferencedImages(normalizedCss);

    return {
        normalizedCss,
        referencedImages,
    };
}

export async function syncPdfjsViewerCss({check = false} = {}) {
    const plan = await createPdfjsViewerCssSyncPlan();
    const {
        normalizedCss,
        referencedImages,
    } = plan;

    if (check) {
        await assertFreshness(plan);
        return {
            checked: true,
            imageCount: referencedImages.length,
        };
    }

    await mkdir(path.dirname(targetCssPath), { recursive: true });
    await writeFile(targetCssPath, normalizedCss, 'utf8');
    await syncImages(referencedImages);

    return {
        checked: false,
        imageCount: referencedImages.length,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const result = await syncPdfjsViewerCss({check: args.check});

    console.log(result.checked
        ? `PDF.js viewer CSS is fresh (${result.imageCount} image assets): ${path.relative(projectRoot, targetCssPath)}`
        : `Synced PDF.js viewer CSS (${result.imageCount} image assets): ${path.relative(projectRoot, targetCssPath)}`);
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    main().catch((error) => {
        console.error('Failed to sync PDF.js viewer CSS:', error);
        process.exit(1);
    });
}
