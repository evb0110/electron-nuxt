import { readdir } from 'node:fs/promises';
import {
    extname,
    join,
    relative,
    sep,
} from 'node:path';

type TNamingIssue = {
    path: string;
    expected: string;
};

const ROOTS = [
    'app',
    'electron',
    'landing',
    'packages',
    'scripts',
    'server',
    'tests',
];

const IGNORED_DIRECTORIES = new Set([
    '.git',
    '.github',
    '.nuxt',
    '.output',
    '.pnpm-store',
    '.vercel',
    'coverage',
    'dist',
    'dist-electron',
    'node_modules',
]);

const ROUTE_DIRECTORY_NAMES = new Set([
    'layouts',
    'middleware',
    'pages',
    'routes',
]);

const LOWER_KEBAB_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CAMEL_RE = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/;

const isLowerKebab = (value: string) => LOWER_KEBAB_RE.test(value);

const isCamel = (value: string) => CAMEL_RE.test(value);

const isPascal = (value: string) => PASCAL_RE.test(value);

const splitPath = (path: string) => path.split(sep);

const isInsideRouteDirectory = (path: string) => splitPath(path).some((part) => ROUTE_DIRECTORY_NAMES.has(part));

const stripKnownTypeScriptSuffixes = (fileName: string): string => {
    let stem = fileName;

    if (stem.endsWith('.d.ts')) {
        stem = stem.slice(0, -'.d.ts'.length);
    } else if (stem.endsWith('.tsx')) {
        stem = stem.slice(0, -'.tsx'.length);
    } else if (stem.endsWith('.ts')) {
        stem = stem.slice(0, -'.ts'.length);
    }

    const approvedDotSuffixes = new Set([
        'client',
        'config',
        'constants',
        'd',
        'e2e',
        'get',
        'modelPrep',
        'post',
        'service',
        'test',
        'ts',
        'txt',
        'types',
        'worker',
        'xml',
    ]);

    const parts = stem.split('.');

    while (parts.length > 1 && approvedDotSuffixes.has(parts.at(-1) ?? '')) {
        parts.pop();
    }

    return parts.join('.');
};

const isValidTypeScriptFileName = (fileName: string): boolean => {
    const stem = stripKnownTypeScriptSuffixes(fileName);

    return isCamel(stem);
};

const isValidVueFileName = (relativePath: string, fileName: string): boolean => {
    const stem = fileName.slice(0, -'.vue'.length);

    if (fileName === 'app.vue' || fileName === 'error.vue') {
        return true;
    }

    if (isInsideRouteDirectory(relativePath)) {
        return isLowerKebab(stem) || isCamel(stem);
    }

    return isPascal(stem);
};

const collectNamingIssues = async (directory: string, issues: TNamingIssue[]): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const absolutePath = join(directory, entry.name);
        const relativePath = relative(process.cwd(), absolutePath);

        if (entry.isDirectory()) {
            if (IGNORED_DIRECTORIES.has(entry.name)) {
                continue;
            }

            if (!isLowerKebab(entry.name)) {
                issues.push({
                    path: relativePath,
                    expected: 'directory names must be lower kebab-case',
                });
            }

            await collectNamingIssues(absolutePath, issues);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const extension = extname(entry.name);

        if ((extension === '.ts' || extension === '.tsx') && !isValidTypeScriptFileName(entry.name)) {
            issues.push({
                path: relativePath,
                expected: 'TypeScript filenames must be camelCase, with only approved dot suffixes',
            });
            continue;
        }

        if (extension === '.vue' && !isValidVueFileName(relativePath, entry.name)) {
            issues.push({
                path: relativePath,
                expected: 'Vue components must be PascalCase; Nuxt route files may be lower kebab-case',
            });
        }
    }
};

const issues: TNamingIssue[] = [];

function parseRoots(argv = process.argv.slice(2)): string[] {
    const rootsArg = argv.find(argument => argument.startsWith('--roots='));
    if (!rootsArg) {
        return ROOTS;
    }

    const roots = rootsArg
        .slice('--roots='.length)
        .split(',')
        .map(root => root.trim())
        .filter(Boolean);

    if (roots.length === 0) {
        throw new Error('Expected --roots to include at least one root.');
    }

    return roots;
}

for (const root of parseRoots()) {
    await collectNamingIssues(root, issues);
}

if (issues.length > 0) {
    console.error('Naming convention check failed:');

    for (const issue of issues) {
        console.error(`- ${issue.path}: ${issue.expected}`);
    }

    process.exitCode = 1;
} else {
    console.log('Naming convention check passed.');
}
