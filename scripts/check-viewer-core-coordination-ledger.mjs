import {
    readFile,
    readdir,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ledgerPath = fileURLToPath(new URL(
    '../docs/architecture/viewer-core-coordination-primitives.json',
    import.meta.url,
));
const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

async function listSourceFiles(root) {
    const entries = await readdir(root, {withFileTypes: true}).catch(() => []);
    const files = await Promise.all(entries.map(entry => (
        entry.isDirectory()
            ? listSourceFiles(resolve(root, entry.name))
            : Promise.resolve(entry.name.endsWith('.ts') || entry.name.endsWith('.vue')
                ? [resolve(root, entry.name)]
                : [])
    )));
    return files.flat();
}

if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.stages) || ledger.stages.length === 0) {
    throw new Error('Viewer-core coordination ledger has an invalid schema');
}

let previousTotal = Number.POSITIVE_INFINITY;
for (const entry of ledger.stages) {
    const categories = entry.categories ?? {};
    const identifiers = [
        ...(categories.timers ?? []),
        ...(categories.locks ?? []),
        ...(categories.counters ?? []),
    ];
    if (new Set(identifiers).size !== identifiers.length) {
        throw new Error(`Viewer-core coordination ledger stage ${entry.stage} contains duplicate identifiers`);
    }
    if (identifiers.length > previousTotal) {
        throw new Error(
            `Viewer-core coordination primitives increased at stage ${entry.stage}: ${previousTotal} -> ${identifiers.length}`,
        );
    }
    previousTotal = identifiers.length;
}

const baseline = ledger.stages[0];
const baselineTotal = Object.values(baseline.categories)
    .reduce((total, identifiers) => total + identifiers.length, 0);
if (baselineTotal !== 50) {
    throw new Error(`Viewer-core coordination baseline must remain the audited 50 primitives, received ${baselineTotal}`);
}

const finalStage = ledger.stages.at(-1);
if (finalStage.status === 'complete') {
    const finalTotal = Object.values(finalStage.categories)
        .reduce((total, identifiers) => total + identifiers.length, 0);
    if (finalTotal >= ledger.finalTargetExclusive) {
        throw new Error(`Completed viewer-core rework must have fewer than ${ledger.finalTargetExclusive} primitives`);
    }
}

for (const guardedRoot of ledger.newCorePolicy.guardedRoots) {
    const files = await listSourceFiles(resolve(repositoryRoot, guardedRoot));
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        for (const pattern of ledger.newCorePolicy.forbiddenPatterns) {
            if (source.includes(pattern)) {
                throw new Error(`New viewer core contains prohibited correctness timer ${pattern} in ${file}`);
            }
        }
    }
}

process.stdout.write(`Viewer-core coordination ledger valid: ${previousTotal} primitive(s) at stage ${finalStage.stage}\n`);
