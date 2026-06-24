import {
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
    findCommonJsNamedImportViolations,
    type ICommonJsImportViolation,
} from '@scripts/findCommonJsNamedImportViolations';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIRECTORIES = [
    'app',
    'electron',
    'packages',
    'server',
    'scripts',
    'tests',
];
const SOURCE_EXTENSIONS = new Set([
    '.js',
    '.jsx',
    '.mjs',
    '.ts',
    '.tsx',
    '.vue',
]);
const IGNORED_DIRECTORIES = new Set([
    '.git',
    '.nuxt',
    '.output',
    '.tmp',
    'coverage',
    'dist',
    'dist-electron',
    'node_modules',
    'nuxt-output',
]);
async function collectSourceFiles(dirPath: string): Promise<string[]> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
            continue;
        }

        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectSourceFiles(entryPath));
            continue;
        }

        if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) {
            files.push(entryPath);
        }
    }

    return files;
}

async function main() {
    const sourceFiles = (await Promise.all(
        SOURCE_DIRECTORIES.map((directory) => collectSourceFiles(path.join(REPO_ROOT, directory))),
    )).flat();
    const violations: ICommonJsImportViolation[] = [];

    for (const sourceFile of sourceFiles) {
        const source = await readFile(sourceFile, 'utf-8');
        violations.push(...findCommonJsNamedImportViolations(sourceFile, source));
    }

    if (violations.length === 0) {
        console.log('CommonJS import compatibility check passed.');
        return;
    }

    console.error('CommonJS import compatibility check failed.');
    for (const violation of violations) {
        const relativePath = path.relative(REPO_ROOT, violation.filePath);
        console.error(
            `- ${relativePath}:${violation.line} imports runtime named export(s) ${
                violation.importedNames.join(', ')
            } from CommonJS package "${violation.packageName}".`,
        );
        console.error(`  Use: ${violation.suggestedImport}`);
    }
    process.exitCode = 1;
}

main().catch((error: unknown) => {
    console.error('Failed to check CommonJS imports:', error);
    process.exitCode = 1;
});
