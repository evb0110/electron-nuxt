import {
    copyFile,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IWindowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    loadFixtureManifest,
    verifyFixturePack,
} from '@scripts/windows-test/fixtures/fixtureManifest';
import { runWindowsFixtureGeneration } from '@scripts/windows-test/fixtures/generateWindowsFixturesCli';
import { bundleGuestWorker } from '@scripts/windows-test/guest/bundleGuestWorker';
import { withHostLock } from '@scripts/windows-test/host/hostLock';
import type { IHostLockDependencies } from '@scripts/windows-test/host/hostLock';

export async function prepareWindowsTestHost(options: {
    layout: IWindowsTestHostLayout;
    repositoryRoot: string;
    lock: IHostLockDependencies;
}) {
    const {
        layout,
        repositoryRoot,
        lock,
    } = options;
    await mkdir(layout.root, { recursive: true });
    return withHostLock(layout.lockFile, lock, async () => {
        // Even a stale lease needs its explicit recovery path before cached
        // inputs can change. Never replace files an existing run may consume.
        if (await stat(layout.leaseFile).catch(() => null)) {
            throw new Error('A Windows test lease exists. Finish or recover that run with windows:test:stop before preparing inputs.');
        }
        for (const directory of [
            layout.baselinesDir,
            layout.clonesDir,
            layout.artifactsCacheDir,
            layout.fixturesCacheDir,
            layout.toolsCacheDir,
            layout.runsDir,
            layout.mailboxDir,
        ]) {
            await mkdir(directory, { recursive: true });
        }
        const generated = await runWindowsFixtureGeneration({
            outputDirectory: layout.fixturesCacheDir,
            relativeTo: layout.fixturesCacheDir,
            write: true,
        });
        const byId = new Map(generated.entries.map(entry => [
            entry.fixtureId,
            entry,
        ]));
        const manifest = await loadFixtureManifest(path.join(repositoryRoot, 'tests/windows/fixtures/manifest.json'));
        const declaredFiles = manifest.packs.flatMap(pack => pack.files);
        const declaredIds = new Set(declaredFiles.map(file => file.id));
        for (const id of byId.keys()) {
            if (!declaredIds.has(id)) {
                throw new Error(`Generated fixture ${id} is absent from the repository manifest.`);
            }
        }
        for (const file of declaredFiles) {
            if (file.generated) {
                const entry = byId.get(file.id);
                if (entry === undefined) {
                    throw new Error(`Declared fixture ${file.id} was not generated.`);
                }
                file.path = entry.relativePath;
                file.bytes = entry.bytes;
                file.sha256 = entry.sha256;
            } else {
                const source = path.resolve(repositoryRoot, 'tests/windows/fixtures', file.path);
                const destination = `${file.id}${path.extname(source)}`;
                await copyFile(source, path.join(layout.fixturesCacheDir, destination));
                file.path = destination;
            }
        }
        const verification = await verifyFixturePack(layout.fixturesCacheDir, manifest);
        if (verification.problems.length > 0) {
            throw new Error(`Prepared fixtures failed verification: ${JSON.stringify(verification.problems)}`);
        }
        const fixtureManifestFile = path.join(layout.fixturesCacheDir, 'manifest.json');
        const temporaryManifest = `${fixtureManifestFile}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
            await rename(temporaryManifest, fixtureManifestFile);
        } finally {
            await rm(temporaryManifest, { force: true });
        }

        const workerDirectory = path.join(layout.toolsCacheDir, 'worker');
        const powerShellDirectory = path.join(workerDirectory, 'powershell');
        await mkdir(powerShellDirectory, { recursive: true });
        const workerFile = path.join(workerDirectory, 'guestWorker.cjs');
        const temporaryWorkerDirectory = path.join(workerDirectory, `.bundle-${randomUUID()}`);
        await mkdir(temporaryWorkerDirectory);
        try {
            const temporaryWorkerFile = path.join(temporaryWorkerDirectory, 'guestWorker.cjs');
            await bundleGuestWorker({
                repoRoot: repositoryRoot,
                outFile: temporaryWorkerFile,
            });
            await rename(`${temporaryWorkerFile}.map`, `${workerFile}.map`);
            await rename(temporaryWorkerFile, workerFile);
        } finally {
            await rm(temporaryWorkerDirectory, {
                recursive: true,
                force: true,
            });
        }
        const scriptsDirectory = path.join(repositoryRoot, 'scripts/windows-test/guest/powershell');
        for (const name of await readdir(scriptsDirectory)) {
            if (name.endsWith('.ps1')) {
                await copyFile(path.join(scriptsDirectory, name), path.join(powerShellDirectory, name));
            }
        }
        // Preserve machine configuration and all VM images. Preparing code and
        // fixtures cannot establish a Windows installation or qualify a driver.
        return {
            workerFile,
            fixtureManifestFile,
            fixtureCount: declaredFiles.length,
            configPresent: await readFile(layout.configFile).then(() => true, () => false),
        };
    });
}
