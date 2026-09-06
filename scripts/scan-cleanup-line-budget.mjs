#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {
    readFileSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const SOURCE_EXTENSIONS = new Set([
    '.rs',
    '.ts',
    '.tsx',
    '.vue',
]);
const SCAN_CLEANUP_TEST_PATH = /scan[-_]?cleanup/iu;
/** @typedef {{byFile: Record<string, number>, path: string, total: number}} ILineHome */
/** @typedef {{homes: Record<string, ILineHome>, productionTotal: number, tests: {byFile: Record<string, number>, total: number}}} ILineCounts */
/** @typedef {{homes: Record<string, {lines: number, path: string}>, productionTotal: number, version: number}} ILineBudgetBaseline */

/** @type {ReadonlyArray<[string, string]>} */
export const SCAN_CLEANUP_HOMES = Object.freeze([
    [
        'app',
        'app/modules/scan-cleanup',
    ],
    [
        'electron',
        'electron/features/scan-cleanup',
    ],
    [
        'contracts',
        'packages/contracts/scan-cleanup',
    ],
    [
        'core',
        'scan-cleanup-core',
    ],
    [
        'adapters',
        'scan-cleanup-adapters',
    ],
    [
        'native',
        'native/scan-cleanup',
    ],
]);

export const SCAN_CLEANUP_LINE_BUDGET_BASELINE = 'scan-cleanup-line-budget-baseline.json';

/** @param {string} value @returns {string} */
function preserveNewlines(value) {
    return value.replace(/[^\n]/gu, ' ');
}

/** @param {string} source @param {number} index @returns {boolean} */
function startsRustCharLiteral(source, index) {
    return /^'(?:\\[^\n]|[^'\\\n])'/u.test(source.slice(index));
}

/** @param {string} source @returns {string} */
function maskRustNonCode(source) {
    let output = '';
    let state = 'code';
    let quote = '';
    let rawTerminator = '';
    let blockDepth = 0;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (state === 'line-comment') {
            output += character === '\n' ? '\n' : ' ';
            if (character === '\n') state = 'code';
            continue;
        }
        if (state === 'block-comment') {
            if (character === '/' && next === '*') {
                blockDepth += 1;
                output += '  ';
                index += 1;
            } else if (character === '*' && next === '/') {
                blockDepth -= 1;
                output += '  ';
                index += 1;
                if (blockDepth === 0) state = 'code';
            } else {
                output += character === '\n' ? '\n' : ' ';
            }
            continue;
        }
        if (state === 'raw-string') {
            if (source.slice(index, index + rawTerminator.length) === rawTerminator) {
                output += preserveNewlines(rawTerminator);
                index += rawTerminator.length - 1;
                state = 'code';
            } else {
                output += character === '\n' ? '\n' : ' ';
            }
            continue;
        }
        if (state === 'string' || state === 'char') {
            output += character === '\n' ? '\n' : ' ';
            if (character === '\\') {
                if (next !== undefined) {
                    output += next === '\n' ? '\n' : ' ';
                    index += 1;
                }
            } else if (character === quote) {
                state = 'code';
            }
            continue;
        }
        const rawStart = source.slice(index).match(/^(?:br|r)(#*)"/u);
        if (rawStart) {
            const hashes = rawStart[1]?.length ?? 0;
            const prefixLength = (rawStart[0]?.length ?? 0);
            rawTerminator = `"${'#'.repeat(hashes)}`;
            output += preserveNewlines(source.slice(index, index + prefixLength));
            index += prefixLength - 1;
            state = 'raw-string';
        } else if (character === '/' && next === '/') {
            output += '  ';
            index += 1;
            state = 'line-comment';
        } else if (character === '/' && next === '*') {
            output += '  ';
            index += 1;
            blockDepth = 1;
            state = 'block-comment';
        } else if (character === '"' || (character === '\'' && startsRustCharLiteral(source, index))) {
            output += ' ';
            quote = character;
            state = character === '"' ? 'string' : 'char';
        } else {
            output += character;
        }
    }
    return output;
}

/** @param {string} source @returns {string} */
function stripRustComments(source) {
    let output = '';
    let state = 'code';
    let quote = '';
    let rawTerminator = '';
    let blockDepth = 0;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (state === 'line-comment') {
            if (character === '\n') {
                output += character;
                state = 'code';
            }
            continue;
        }
        if (state === 'block-comment') {
            if (character === '/' && next === '*') {
                blockDepth += 1;
                index += 1;
            } else if (character === '*' && next === '/') {
                blockDepth -= 1;
                index += 1;
                if (blockDepth === 0) state = 'code';
            } else if (character === '\n') {
                output += character;
            }
            continue;
        }
        if (state === 'raw-string') {
            output += character;
            if (source.slice(index, index + rawTerminator.length) === rawTerminator) {
                index += rawTerminator.length - 1;
                state = 'code';
            }
            continue;
        }
        if (state === 'string' || state === 'char') {
            output += character;
            if (character === '\\' && next !== undefined) {
                output += next;
                index += 1;
            } else if (character === quote) {
                state = 'code';
            }
            continue;
        }
        const rawStart = source.slice(index).match(/^(?:br|r)(#*)"/u);
        if (rawStart) {
            const hashes = rawStart[1]?.length ?? 0;
            const prefixLength = rawStart[0]?.length ?? 0;
            rawTerminator = `"${'#'.repeat(hashes)}`;
            output += source.slice(index, index + prefixLength);
            index += prefixLength - 1;
            state = 'raw-string';
        } else if (character === '/' && next === '/') {
            index += 1;
            state = 'line-comment';
        } else if (character === '/' && next === '*') {
            index += 1;
            blockDepth = 1;
            state = 'block-comment';
        } else if (character === '"' || (character === '\'' && startsRustCharLiteral(source, index))) {
            output += character;
            quote = character;
            state = character === '"' ? 'string' : 'char';
        } else {
            output += character;
        }
    }
    return output;
}

/** @param {string} source @returns {number} */
function countRustCodeLines(source) {
    const split = splitRustTestCodeLines(source);
    return split.productionLines.length + split.testCodeLines.length;
}

/** @param {string} source @returns {{productionLines: number[], testCodeLines: number[]}} */
export function splitRustTestCodeLines(source) {
    const masked = maskRustNonCode(source);
    /** @type {Set<number>} */
    const testLines = new Set();
    for (const match of masked.matchAll(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/gu)) {
        const openingBrace = masked.indexOf('{', (match.index ?? 0) + match[0].length);
        if (openingBrace < 0) continue;
        let depth = 0;
        let closingBrace = -1;
        for (let index = openingBrace; index < masked.length; index += 1) {
            if (masked[index] === '{') depth += 1;
            else if (masked[index] === '}') {
                depth -= 1;
                if (depth === 0) {
                    closingBrace = index;
                    break;
                }
            }
        }
        if (closingBrace < 0) continue;
        const startLine = source.slice(0, match.index ?? 0).split('\n').length - 1;
        const endLine = source.slice(0, closingBrace + 1).split('\n').length - 1;
        for (let line = startLine; line <= endLine; line += 1) testLines.add(line);
    }
    /** @type {number[]} */
    const productionLines = [];
    /** @type {number[]} */
    const testCodeLines = [];
    const codeLines = stripRustComments(source)
        .split(/\r?\n/u)
        .map(/** @param {string} line */ line => line.trim().length > 0);
    for (const [
        line,
        hasCode,
    ] of codeLines.entries()) {
        if (!hasCode) continue;
        (testLines.has(line) ? testCodeLines : productionLines).push(line);
    }
    return {
        productionLines,
        testCodeLines,
    };
}

/** @param {string} root @param {string} relativeDirectory @returns {string[]} */
function sourceFiles(root, relativeDirectory) {
    const directory = path.join(root, relativeDirectory);
    /** @type {string[]} */
    const files = [];
    /** @param {string} currentDirectory */
    const visit = currentDirectory => {
        for (const entry of readdirSync(currentDirectory, {withFileTypes: true})) {
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                visit(entryPath);
            } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
                files.push(entryPath);
            }
        }
    };
    visit(directory);
    return files.sort();
}

/** @param {string} root @param {string} filePath @returns {boolean} */
function isTestFile(root, filePath) {
    const relativePath = path.relative(root, filePath).split(path.sep).join('/');
    const isNamedHome = SCAN_CLEANUP_HOMES.some(([
        , home,
    ]) => relativePath.startsWith(`${home}/`));
    const fileName = path.basename(relativePath);
    const isTestNamed = /(?:^|[._-])(?:test|tests|spec|specs)(?:[._-]|$)/iu.test(fileName);
    return relativePath.startsWith('native/scan-cleanup/tests/')
        || (relativePath.startsWith('tests/') && SCAN_CLEANUP_TEST_PATH.test(relativePath))
        || (isNamedHome && isTestNamed);
}

/** @param {string} source @returns {string} */
function stripComments(source) {
    let output = '';
    let state = 'code';
    let quote = '';
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (state === 'line-comment') {
            if (character === '\n') {
                output += character;
                state = 'code';
            }
            continue;
        }
        if (state === 'block-comment' || state === 'html-comment') {
            const closesComment = state === 'block-comment'
                ? character === '*' && next === '/'
                : source.slice(index, index + 3) === '-->';
            if (closesComment) {
                index += state === 'html-comment' ? 2 : 1;
                state = 'code';
            } else if (character === '\n') {
                output += character;
            }
            continue;
        }
        if (state === 'string') {
            output += character;
            if (character === '\\') {
                if (next !== undefined) {
                    output += next;
                    index += 1;
                }
            } else if (character === quote) {
                state = 'code';
            }
            continue;
        }
        if (source.slice(index, index + 4) === '<!--') {
            index += 3;
            state = 'html-comment';
        } else if (character === '/' && next === '/') {
            index += 1;
            state = 'line-comment';
        } else if (character === '/' && next === '*') {
            index += 1;
            state = 'block-comment';
        } else if (character === '"' || character === '\'' || character === '`') {
            output += character;
            quote = character;
            state = 'string';
        } else {
            output += character;
        }
    }
    return output;
}

/** @param {string} source @returns {number} */
export function countCodeLines(source) {
    return stripComments(source)
        .split(/\r?\n/u)
        .filter(line => line.trim().length > 0)
        .length;
}

/** @param {string} root @param {string[]} files @returns {{byFile: Record<string, number>, total: number}} */
function countFiles(root, files, {allAsTests = false} = {}) {
    const byFile = /** @type {Record<string, number>} */ (Object.fromEntries(files.map(filePath => [
        path.relative(root, filePath).split(path.sep).join('/'),
        allAsTests
            ? path.extname(filePath) === '.rs'
                ? countRustCodeLines(readFileSync(filePath, 'utf8'))
                : countCodeLines(readFileSync(filePath, 'utf8'))
            : path.extname(filePath) === '.rs'
                ? splitRustTestCodeLines(readFileSync(filePath, 'utf8')).productionLines.length
                : countCodeLines(readFileSync(filePath, 'utf8')),
    ])));
    return {
        byFile,
        total: Object.values(byFile).reduce((total, lines) => total + lines, 0),
    };
}

/** @param {string} root @returns {ILineCounts} */
export function collectScanCleanupLineCounts(root) {
    /** @type {Record<string, ILineHome>} */
    const homes = {};
    const tests = [];
    for (const [
        name,
        relativeDirectory,
    ] of SCAN_CLEANUP_HOMES) {
        const files = sourceFiles(root, relativeDirectory);
        const productionFiles = files.filter(filePath => !isTestFile(root, filePath));
        const homeCounts = countFiles(root, productionFiles);
        homes[name] = {
            path: relativeDirectory,
            ...homeCounts,
        };
        tests.push(...files.filter(filePath => isTestFile(root, filePath)));
    }

    const testFiles = sourceFiles(root, 'tests')
        .filter(filePath => isTestFile(root, filePath));
    for (const filePath of testFiles) {
        if (!tests.includes(filePath)) tests.push(filePath);
    }
    const testCounts = countFiles(root, tests.sort(), {allAsTests: true});
    for (const filePath of SCAN_CLEANUP_HOMES.flatMap(([
        , directory,
    ]) => sourceFiles(root, directory))) {
        if (isTestFile(root, filePath) || path.extname(filePath) !== '.rs') continue;
        const relativePath = path.relative(root, filePath).split(path.sep).join('/');
        const inlineTests = splitRustTestCodeLines(readFileSync(filePath, 'utf8')).testCodeLines.length;
        if (inlineTests > 0) testCounts.byFile[relativePath] = (testCounts.byFile[relativePath] ?? 0) + inlineTests;
    }
    testCounts.total = Object.values(testCounts.byFile).reduce((total, lines) => total + lines, 0);
    return {
        homes,
        productionTotal: Object.values(homes).reduce((total, home) => total + home.total, 0),
        tests: testCounts,
    };
}

/** @param {ILineCounts} counts @param {ILineBudgetBaseline} baseline @param {{allowBaselineIncrease?: boolean}} [options] */
export function evaluateScanCleanupLineBudget(counts, baseline, {allowBaselineIncrease = false} = {}) {
    const failures = [];
    for (const [
        name,
        home,
    ] of Object.entries(counts.homes)) {
        const baselineHome = baseline.homes?.[name];
        const baselineLines = baselineHome?.lines;
        if (!Number.isInteger(baselineLines)) {
            failures.push(`${name} has no committed baseline`);
        } else if (typeof baselineLines === 'number' && home.total > baselineLines && !allowBaselineIncrease) {
            failures.push(`${name} grew by ${home.total - baselineLines} code lines (${home.total} > ${baselineLines})`);
        }
    }
    const baselineTotal = baseline.productionTotal;
    if (!Number.isInteger(baselineTotal)) failures.push('production total has no committed baseline');
    else if (counts.productionTotal > baselineTotal) {
        failures.push(`production total grew by ${counts.productionTotal - baselineTotal} code lines (${counts.productionTotal} > ${baselineTotal})`);
    }
    return {
        baselineTotal,
        failures: [...new Set(failures)],
        passed: failures.length === 0,
    };
}

/** @param {{homes: Record<string, {lines: number}>, productionTotal: number}} current @param {{homes: Record<string, {lines: number}>, productionTotal: number} | null} previous @param {{allowHomeIncrease?: boolean}} [options] */
export function compareScanCleanupBaselines(current, previous, {allowHomeIncrease = false} = {}) {
    validateScanCleanupBaseline(current, 'current baseline');
    if (previous === null) {
        return {
            bootstrap: true,
            failures: [],
        };
    }
    validateScanCleanupBaseline(previous, 'base baseline');
    const failures = [];
    for (const [
        name,
        home,
    ] of Object.entries(current.homes)) {
        const previousLines = previous.homes?.[name]?.lines;
        if (typeof previousLines !== 'number') {
            failures.push(`${name} has no baseline at the supplied base ref`);
        } else if (home.lines > previousLines && !allowHomeIncrease) {
            failures.push(`${name} baseline increased by ${home.lines - previousLines} code lines`);
        }
    }
    if (current.productionTotal > previous.productionTotal) {
        failures.push(`production total baseline increased by ${current.productionTotal - previous.productionTotal} code lines`);
    }
    return {
        bootstrap: false,
        failures,
    };
}

/** @param {unknown} value @param {string} label @returns {ILineBudgetBaseline} */
export function validateScanCleanupBaseline(value, label = 'baseline') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    const candidate = /** @type {Record<string, unknown>} */ (value);
    if (candidate.version !== 1) throw new Error(`${label} has unsupported version.`);
    const productionTotal = candidate.productionTotal;
    if (typeof productionTotal !== 'number' || !Number.isInteger(productionTotal) || productionTotal < 0) {
        throw new Error(`${label} productionTotal must be a nonnegative integer.`);
    }
    if (candidate.homes === null || typeof candidate.homes !== 'object' || Array.isArray(candidate.homes)) {
        throw new Error(`${label} homes must be an object.`);
    }
    const homes = /** @type {Record<string, unknown>} */ (candidate.homes);
    const expectedNames = SCAN_CLEANUP_HOMES.map(([name]) => name).sort();
    if (JSON.stringify(Object.keys(homes).sort()) !== JSON.stringify(expectedNames)) {
        throw new Error(`${label} must contain exactly the six named scan-cleanup homes.`);
    }
    for (const [
        name,
        expectedPath,
    ] of SCAN_CLEANUP_HOMES) {
        const home = homes[name];
        if (home === null || typeof home !== 'object' || Array.isArray(home)) {
            throw new Error(`${label} home ${name} must be an object.`);
        }
        const entry = /** @type {Record<string, unknown>} */ (home);
        if (entry.path !== expectedPath) throw new Error(`${label} home ${name} has an unexpected path.`);
        const lines = entry.lines;
        if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 0) {
            throw new Error(`${label} home ${name} lines must be a nonnegative integer.`);
        }
    }
    return /** @type {ILineBudgetBaseline} */ (value);
}

/** @param {ILineCounts} counts @returns {ILineBudgetBaseline} */
function baselineFromCounts(counts) {
    return {
        version: 1,
        productionTotal: counts.productionTotal,
        homes: Object.fromEntries(Object.entries(counts.homes).map(([
            name,
            home,
        ]) => [
            name,
            {
                lines: home.total,
                path: home.path,
            },
        ])),
    };
}

/** @param {string} root @returns {ILineBudgetBaseline} */
function readBaseline(root) {
    return validateScanCleanupBaseline(
        JSON.parse(readFileSync(path.join(root, SCAN_CLEANUP_LINE_BUDGET_BASELINE), 'utf8')),
    );
}

/** @param {string[]} argv @returns {string} */
function resolveBaseRef(argv) {
    const explicit = readOption(argv, 'base-ref') ?? process.env.EVB_SCAN_CLEANUP_BASE_REF;
    if (explicit) {
        return explicit;
    }
    try {
        return execFileSync('git', [
            'merge-base',
            'HEAD',
            'origin/main',
        ], {encoding: 'utf8'}).trim();
    } catch {
        throw new Error('Cannot determine a scan-cleanup baseline base ref. Pass --base-ref=<commit> or EVB_SCAN_CLEANUP_BASE_REF.');
    }
}

/** @param {string} root @param {string} baseRef @returns {ILineBudgetBaseline | null} */
function readBaselineAtRef(root, baseRef) {
    try {
        execFileSync('git', [
            'rev-parse',
            '--verify',
            `${baseRef}^{commit}`,
        ], {
            cwd: root,
            stdio: 'ignore',
        });
    } catch {
        throw new Error(`Cannot verify scan-cleanup baseline base ref "${baseRef}".`);
    }
    let baselineText;
    try {
        baselineText = execFileSync('git', [
            'show',
            `${baseRef}:${SCAN_CLEANUP_LINE_BUDGET_BASELINE}`,
        ], {
            cwd: root,
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        });
    } catch {
        return null;
    }
    return validateScanCleanupBaseline(JSON.parse(baselineText), 'base baseline');
}

/** @param {string} root @param {ILineCounts} counts */
function writeBaseline(root, counts) {
    writeFileSync(
        path.join(root, SCAN_CLEANUP_LINE_BUDGET_BASELINE),
        `${JSON.stringify(baselineFromCounts(counts), null, 2)}\n`,
        'utf8',
    );
}

/** @param {string[]} argv @param {string} name @returns {string | undefined} */
function readOption(argv, name) {
    return argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/** @param {{argv?: string[], root?: string}} [options] */
export function runScanCleanupLineBudget({
    argv = process.argv.slice(2),
    root = process.cwd(),
} = {}) {
    const counts = collectScanCleanupLineCounts(root);
    const baseline = readBaseline(root);
    const baseRef = resolveBaseRef(argv);
    const previousBaseline = readBaselineAtRef(root, baseRef);
    const overrideReason = readOption(argv, 'allow-baseline-increase') ?? readOption(argv, 'override');
    const updateBaseline = argv.includes('--update-baseline');
    const allowBaselineIncrease = overrideReason !== undefined;
    const baselineComparison = compareScanCleanupBaselines(baseline, previousBaseline, {allowHomeIncrease: allowBaselineIncrease});
    const evaluation = evaluateScanCleanupLineBudget(counts, baseline, {allowBaselineIncrease});
    process.stdout.write('Scan-cleanup code-line budget\n');
    for (const [
        name,
        home,
    ] of Object.entries(counts.homes)) {
        const baselineLines = baseline.homes?.[name]?.lines ?? 'missing';
        process.stdout.write(`  ${name}: ${home.total} (baseline ${baselineLines}, delta ${typeof baselineLines === 'number' ? home.total - baselineLines : 'n/a'})\n`);
    }
    process.stdout.write(`  production total: ${counts.productionTotal} (baseline ${evaluation.baselineTotal}, delta ${counts.productionTotal - evaluation.baselineTotal})\n`);
    process.stdout.write(`  tests: ${counts.tests.total} code lines across ${Object.keys(counts.tests.byFile).length} files (reported separately)\n`);
    process.stdout.write(`  baseline base ref: ${baseRef}${baselineComparison.bootstrap ? ' (bootstrap, no baseline at ref)' : ''}\n`);

    if (baselineComparison.failures.length > 0) {
        throw new Error(`Scan-cleanup baseline policy failed: ${baselineComparison.failures.join('; ')}`);
    }

    if (updateBaseline) {
        const hasHomeIncrease = Object.entries(counts.homes).some(([
            name,
            home,
        ]) => {
            const baselineLines = baseline.homes?.[name]?.lines;
            return typeof baselineLines === 'number' && home.total > baselineLines;
        });
        if (allowBaselineIncrease && !/^consolidation:\s*\S/iu.test(overrideReason?.trim() ?? '')) {
            throw new Error('Baseline increase override requires a non-empty reason.');
        }
        if (counts.productionTotal > evaluation.baselineTotal) {
            throw new Error('Refusing to raise the production total. Consolidation overrides may only rebalance named-home baselines without growing the production total.');
        }
        if (hasHomeIncrease && !allowBaselineIncrease) {
            throw new Error('Refusing to raise the baseline. Use --update-baseline --allow-baseline-increase=consolidation:... for a consolidation commit.');
        }
        writeBaseline(root, counts);
        if (allowBaselineIncrease) process.stdout.write(`  Baseline increase override: ${overrideReason}\n`);
        else process.stdout.write('  Baseline updated without increasing production budget.\n');
        return {
            counts,
            evaluation,
            updatedBaseline: true,
        };
    }
    if (allowBaselineIncrease) {
        throw new Error('Baseline override is only valid with --update-baseline.');
    }
    if (!evaluation.passed) {
        throw new Error(`Scan-cleanup line budget exceeded: ${evaluation.failures.join('; ')}`);
    }
    return {
        counts,
        evaluation,
        updatedBaseline: false,
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    try {
        runScanCleanupLineBudget();
    } catch (error) {
        process.stderr.write(`${String(error)}\n`);
        process.exitCode = 1;
    }
}
