#!/usr/bin/env node

/*
 * Population: const and static items in production native/scan-cleanup/src
 * whose declared type mentions f32 or f64, including scalars and aggregates.
 * src/bin/** and *_tests.rs are excluded. Casts and macro-generated items are
 * an explicitly out-of-scope limitation. generatedBy is documentation only;
 * count equality and the byte-for-byte canonical comparison are the integrity
 * mechanisms.
 */

import {
    readdir,
    readFile,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
    relative,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = join(projectRoot, 'native/scan-cleanup/src');
export const thresholdBaselinePath = join(
    projectRoot,
    'native/scan-cleanup/named-float-const-baseline.json',
);
export const thresholdBaselineGenerator = 'pnpm run generate:scan-cleanup-threshold-baseline';

const namedFloatConstPattern = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+[A-Za-z_]\w*\s*:\s*[^=;]*\bf(?:32|64)\b/gmu;

function blankCharacter(character) {
    return character === '\n' || character === '\r' ? character : ' ';
}

export function stripRustCommentsAndStrings(source) {
    const stripped = source.split('');
    let index = 0;
    while (index < source.length) {
        if (source.startsWith('//', index)) {
            while (index < source.length && source[index] !== '\n') {
                stripped[index] = blankCharacter(source[index]);
                index += 1;
            }
            continue;
        }
        if (source.startsWith('/*', index)) {
            let depth = 0;
            while (index < source.length) {
                if (source.startsWith('/*', index)) {
                    depth += 1;
                    stripped[index] = ' ';
                    stripped[index + 1] = ' ';
                    index += 2;
                    continue;
                }
                if (source.startsWith('*/', index)) {
                    depth -= 1;
                    stripped[index] = ' ';
                    stripped[index + 1] = ' ';
                    index += 2;
                    if (depth === 0) break;
                    continue;
                }
                stripped[index] = blankCharacter(source[index]);
                index += 1;
            }
            continue;
        }

        const rawString = source[index] === 'r' || source.startsWith('br', index)
            ? /^(?:br|r)(#*)"/u.exec(source.slice(index))
            : null;
        if (rawString) {
            const terminator = `"${rawString[1]}`;
            const end = source.indexOf(terminator, index + rawString[0].length);
            const exclusiveEnd = end === -1 ? source.length : end + terminator.length;
            while (index < exclusiveEnd) {
                stripped[index] = blankCharacter(source[index]);
                index += 1;
            }
            continue;
        }

        const stringPrefixLength = source.startsWith('b"', index) ? 2 : source[index] === '"' ? 1 : 0;
        if (stringPrefixLength > 0) {
            let escaped = false;
            const stringStart = index;
            index += stringPrefixLength;
            while (index < source.length) {
                const character = source[index];
                index += 1;
                if (!escaped && character === '"') break;
                escaped = !escaped && character === '\\';
                if (character !== '\\') escaped = false;
            }
            for (let stringIndex = stringStart; stringIndex < index; stringIndex += 1) {
                stripped[stringIndex] = blankCharacter(source[stringIndex]);
            }
            continue;
        }
        index += 1;
    }
    return stripped.join('');
}

async function rustSourceFiles(directory) {
    const entries = await readdir(directory, {withFileTypes: true});
    const files = await Promise.all(entries.map(async entry => {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
            return rustSourceFiles(entryPath);
        }
        return entry.isFile() && entry.name.endsWith('.rs') ? [entryPath] : [];
    }));
    return files.flat().filter(file => {
        const sourceRelativePath = relative(sourceRoot, file);
        return sourceRelativePath.split(/[\\/]/u)[0] !== 'bin'
            && !file.endsWith('_tests.rs');
    });
}

export async function countNamedFloatConsts() {
    const files = await rustSourceFiles(sourceRoot);
    const sources = await Promise.all(files.map(file => readFile(file, 'utf8')));
    return sources.reduce(
        (count, source) => count + (stripRustCommentsAndStrings(source).match(namedFloatConstPattern)?.length ?? 0),
        0,
    );
}

export async function canonicalThresholdBaselineJson() {
    const baseline = {
        count: await countNamedFloatConsts(),
        generatedBy: thresholdBaselineGenerator,
    };
    return `${JSON.stringify(baseline, null, 2)}\n`;
}

export async function checkThresholdBaseline() {
    const [
        committed,
        canonical,
    ] = await Promise.all([
        readFile(thresholdBaselinePath, 'utf8'),
        canonicalThresholdBaselineJson(),
    ]);
    if (committed !== canonical) {
        throw new Error(`Scan-cleanup threshold baseline is stale. Run ${thresholdBaselineGenerator} to regenerate it.`);
    }
}

export async function generateThresholdBaseline() {
    const canonical = await canonicalThresholdBaselineJson();
    await writeFile(thresholdBaselinePath, canonical, 'utf8');
    return JSON.parse(canonical);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--check')) {
        await checkThresholdBaseline();
        process.stdout.write(`Verified ${thresholdBaselinePath}.\n`);
    } else {
        const baseline = await generateThresholdBaseline();
        process.stdout.write(`Wrote ${thresholdBaselinePath} (${baseline.count} named f32/f64 const/static items).\n`);
    }
}
