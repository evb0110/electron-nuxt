#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { getCiChangedAreaPolicy } from '../release/policy.mjs';

function normalizePath(filePath) {
    return filePath.split(path.sep).join('/').replace(/^\.\//u, '');
}

export function matchesChangedAreaPattern(filePath, pattern) {
    const normalizedPath = normalizePath(filePath);
    const normalizedPattern = normalizePath(pattern);
    let expression = '^';
    for (let index = 0; index < normalizedPattern.length; index += 1) {
        const character = normalizedPattern[index];
        if (character === '*' && normalizedPattern[index + 1] === '*') {
            expression += '.*';
            index += 1;
            continue;
        }
        if (character === '*') {
            expression += '[^/]*';
            continue;
        }
        expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
    return new RegExp(`${expression}$`, 'u').test(normalizedPath);
}

export function classifyChangedFiles(files, policy = getCiChangedAreaPolicy()) {
    const normalizedFiles = files?.map(normalizePath).filter(Boolean) ?? null;
    return Object.fromEntries(Object.entries(policy).map(([
        area,
        definition,
    ]) => [
        definition.output,
        {
            area,
            matched: normalizedFiles === null
                || normalizedFiles.some(file => definition.paths.some(pattern => (
                    matchesChangedAreaPattern(file, pattern)
                ))),
            owner: definition.owner,
        },
    ]));
}

function readArgValues(argv, name) {
    const prefix = `--${name}=`;
    return argv.filter(arg => arg.startsWith(prefix)).map(arg => arg.slice(prefix.length));
}

function readSingleArg(argv, name) {
    return readArgValues(argv, name).at(-1);
}

export function getChangedFiles({
    base,
    head,
}) {
    if (!base || !head) {
        throw new Error('Both --base=<sha> and --head=<sha> are required when --file is not provided.');
    }
    try {
        const output = execFileSync('git', [
            'diff',
            '--no-renames',
            '--name-only',
            '--diff-filter=ACDMR',
            '-z',
            `${base}...${head}`,
        ], { encoding: 'utf8' });
        return output.split('\0').filter(Boolean);
    } catch {
        // A force-push replaces the event's `before` commit, so the push
        // payload references a SHA this checkout cannot resolve. There is no
        // honest diff to classify in that case; returning null tells the
        // classifier to run every gate rather than skip any.
        return null;
    }
}

export function runChangedAreaClassifier({
    argv = process.argv.slice(2),
    outputFile = process.env.GITHUB_OUTPUT,
} = {}) {
    const explicitFiles = readArgValues(argv, 'file');
    const files = explicitFiles.length > 0
        ? explicitFiles
        : getChangedFiles({
            base: readSingleArg(argv, 'base'),
            head: readSingleArg(argv, 'head'),
        });
    const result = classifyChangedFiles(files);
    const outputLines = Object.entries(result).map(([
        output,
        classification,
    ]) => (
        `${output}=${classification.matched ? 'true' : 'false'}`
    ));

    if (outputFile) {
        appendFileSync(outputFile, `${outputLines.join('\n')}\n`);
    }
    process.stdout.write(`${JSON.stringify({
        files,
        result,
    }, null, 2)}\n`);
    return result;
}

const isDirectRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
    runChangedAreaClassifier();
}
