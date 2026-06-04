import {
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';

const STYLE_EXTENSIONS = new Set([
    '.css',
    '.scss',
    '.vue',
]);
const TARGET_ROOTS = [
    'app',
    'landing/app',
];
const IMPORTANT_ALLOWANCE_WINDOW_LINES = 8;

const IGNORED_DIRECTORIES = new Set([
    '.git',
    '.nuxt',
    '.output',
    'coverage',
    'dist',
    'node_modules',
    'out',
    'release',
]);

const ALLOWED_PATH_PREFIXES = ['app/assets/css/vendor/'];

const ALLOWED_WHOLE_FILES = new Set([
    'app/assets/css/pdfjs-overrides.css',
    'app/assets/css/pdfjs-overrides.scss',
]);

function toRepoPath(filePath: string) {
    return path.relative(process.cwd(), filePath).split(path.sep).join('/');
}

function isStyleFile(filePath: string) {
    return STYLE_EXTENSIONS.has(path.extname(filePath));
}

function isAllowedWholeFile(repoPath: string) {
    return ALLOWED_WHOLE_FILES.has(repoPath)
        || ALLOWED_PATH_PREFIXES.some(prefix => repoPath.startsWith(prefix));
}

function hasImportantAllowance(lines: string[], lineIndex: number) {
    const startIndex = Math.max(0, lineIndex - IMPORTANT_ALLOWANCE_WINDOW_LINES);

    for (let index = lineIndex; index >= startIndex; index--) {
        if (lines[index]?.includes('css-important-allow:')) {
            return true;
        }
    }

    return false;
}

async function collectStyleFiles(directoryPath: string, files: string[] = []) {
    const entries = await readdir(directoryPath, {withFileTypes: true});

    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name)) {
                await collectStyleFiles(path.join(directoryPath, entry.name), files);
            }
            continue;
        }

        const filePath = path.join(directoryPath, entry.name);
        if (entry.isFile() && isStyleFile(filePath)) {
            files.push(filePath);
        }
    }

    return files;
}

async function main() {
    const violations: string[] = [];

    for (const root of TARGET_ROOTS) {
        const files = await collectStyleFiles(path.resolve(root));

        for (const filePath of files) {
            const repoPath = toRepoPath(filePath);
            if (isAllowedWholeFile(repoPath)) {
                continue;
            }

            const source = await readFile(filePath, 'utf8');
            const lines = source.split(/\r?\n/u);

            lines.forEach((line, lineIndex) => {
                const columnIndex = line.indexOf('!important');
                if (columnIndex === -1 || hasImportantAllowance(lines, lineIndex)) {
                    return;
                }

                violations.push(`${repoPath}:${lineIndex + 1}:${columnIndex + 1}`);
            });
        }
    }

    if (violations.length > 0) {
        console.error('Unexpected !important declarations. Use normal cascade/specificity for app-owned styles, or add a css-important-allow rationale for native/global/PDF.js exceptions.');
        for (const violation of violations) {
            console.error(`  ${violation}`);
        }
        process.exitCode = 1;
    }
}

await main();
