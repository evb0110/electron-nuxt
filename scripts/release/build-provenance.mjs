import {createHash} from 'node:crypto';
import {
    readFile,
    writeFile,
} from 'node:fs/promises';
import {
    basename,
    resolve,
} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

async function sha256(filePath) {
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

export async function createBuildProvenance({
    appAsarPath,
    arch,
    channel,
    outputPath,
}) {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
    const provenance = {
        schemaVersion: 1,
        commitSha: execFileSync('git', [
            'rev-parse',
            'HEAD',
        ], {encoding: 'utf8'}).trim(),
        version: packageJson.version,
        arch,
        channel,
        appAsar: {
            name: basename(appAsarPath),
            sha256: await sha256(appAsarPath),
        },
        lockfileSha256: await sha256(resolve('pnpm-lock.yaml')),
    };
    await writeFile(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
    return provenance;
}

export async function assertMatchingBuildProvenance(directPath, storePath) {
    const direct = JSON.parse(await readFile(directPath, 'utf8'));
    const store = JSON.parse(await readFile(storePath, 'utf8'));
    for (const field of [
        'schemaVersion',
        'commitSha',
        'version',
        'arch',
        'lockfileSha256',
    ]) {
        if (direct[field] !== store[field]) {
            throw new Error(`Build provenance mismatch for ${field}: direct=${direct[field]} store=${store[field]}`);
        }
    }
    if (direct.appAsar?.sha256 !== store.appAsar?.sha256) {
        throw new Error(`Packaged app.asar hash mismatch: direct=${direct.appAsar?.sha256} store=${store.appAsar?.sha256}`);
    }
    return {
        direct,
        store,
    };
}

async function main(argv) {
    const [
        command,
        ...args
    ] = argv;
    if (command === 'create' && args.length === 4) {
        const [
            channel,
            arch,
            appAsarPath,
            outputPath,
        ] = args;
        await createBuildProvenance({
            appAsarPath,
            arch,
            channel,
            outputPath,
        });
        return;
    }
    if (command === 'assert-match' && args.length === 2) {
        await assertMatchingBuildProvenance(args[0], args[1]);
        process.stdout.write('Direct-download and Store packaged application provenance matches.\n');
        return;
    }
    throw new Error('Usage: build-provenance.mjs create <channel> <arch> <app.asar> <output.json> | assert-match <direct.json> <store.json>');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    await main(process.argv.slice(2));
}
