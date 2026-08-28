import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    PageIdentitySidecarCorruptError,
    readIdentityAtFromSidecar,
    streamPageIdentityIds,
} from '@electron/file-access/pageIdentitySidecarStreaming';
import {readPageIdentity} from '@electron/file-access/pageIdentityStore';

vi.mock('@electron/pdf/pdfPageCount', () => ({getPdfPageCount: vi.fn(async () => 3)}));

const roots: string[] = [];

async function createRoot() {
    const root = await mkdtemp(join(tmpdir(), 'evb-page-identity-sidecar-'));
    roots.push(root);
    return root;
}

function validSidecar() {
    return JSON.stringify({
        version: 2,
        storage: 'ranges',
        documentRevisionToken: 'drt1:sidecar-streaming',
        pageCount: 3,
        identitySeed: 'sidecar-streaming-seed',
        pageIds: [
            'page-a',
            'page-b',
            'page-c',
        ],
    });
}

function validLegacySidecar() {
    return JSON.stringify({
        version: 1,
        documentRevisionToken: 'drt1:sidecar-streaming',
        pageIds: [
            'page-a',
            'page-b',
            'page-c',
        ],
    });
}

async function writeSidecar(body: string) {
    const root = await createRoot();
    const path = join(root, 'working.pdf.evb-pages.json');
    await writeFile(path, body);
    return path;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

describe('page identity sidecar streaming (SRCH-007)', () => {
    it('streams every page identity of a complete sidecar', async () => {
        const path = await writeSidecar(`${validSidecar()}\n`);
        const seen: string[] = [];

        await expect(streamPageIdentityIds(path, (id) => {
            seen.push(id);
            return undefined;
        })).resolves.toEqual({
            count: 3,
            foundPageIds: true,
        });
        expect(seen).toEqual([
            'page-a',
            'page-b',
            'page-c',
        ]);
    });

    it('reads identities from a valid lazy sidecar through both lookup paths', async () => {
        const path = await writeSidecar(validLegacySidecar());
        const workingCopyPath = path.slice(0, -'.evb-pages.json'.length);
        await writeFile(workingCopyPath, '%PDF fixture');

        await expect(readIdentityAtFromSidecar({
            format: 'v1',
            path,
        }, 1)).resolves.toBe('page-b');
        await expect(readPageIdentity(workingCopyPath, 3, 3)).resolves.toBe('page-c');
    });

    it('rejects a second JSON object appended after the sidecar', async () => {
        const path = await writeSidecar(`${validSidecar()}{"pageIds":["page-z"]}`);

        await expect(streamPageIdentityIds(path)).rejects.toBeInstanceOf(PageIdentitySidecarCorruptError);
    });

    it('rejects trailing non-whitespace bytes', async () => {
        const path = await writeSidecar(`${validSidecar()}\ngarbage`);

        await expect(streamPageIdentityIds(path)).rejects.toMatchObject({code: 'PAGE_IDENTITY_SIDECAR_CORRUPT'});
    });

    it('rejects unbalanced closing brackets after the sidecar', async () => {
        const path = await writeSidecar(`${validSidecar()}]}`);

        await expect(streamPageIdentityIds(path)).rejects.toBeInstanceOf(PageIdentitySidecarCorruptError);
    });

    it('rejects mismatched delimiters even when their nesting depth balances', async () => {
        const path = await writeSidecar('{"pageIds":["page-a"],"metadata":[}}');

        await expect(streamPageIdentityIds(path)).rejects.toBeInstanceOf(PageIdentitySidecarCorruptError);
    });

    it('rejects a top-level value that is not an object', async () => {
        const path = await writeSidecar('["page-a"]');

        await expect(streamPageIdentityIds(path)).rejects.toBeInstanceOf(PageIdentitySidecarCorruptError);
    });

    it('surfaces the typed corruption error through the identity lookup', async () => {
        const path = await writeSidecar(`${validSidecar()}{"pageIds":["page-z"]}`);

        await expect(readIdentityAtFromSidecar({
            format: 'v2',
            path,
        }, 0)).rejects.toMatchObject({
            name: 'PageIdentitySidecarCorruptError',
            code: 'PAGE_IDENTITY_SIDECAR_CORRUPT',
        });
    });

    it('revalidates a lazy source after its sidecar file changes', async () => {
        const path = await writeSidecar(validSidecar());
        const source = {
            format: 'v2' as const,
            path,
        };

        await expect(readIdentityAtFromSidecar(source, 0)).resolves.toBe('page-a');
        await writeFile(path, `${validSidecar()}garbage`);
        await expect(readIdentityAtFromSidecar(source, 0))
            .rejects.toMatchObject({code: 'PAGE_IDENTITY_SIDECAR_CORRUPT'});
    });

    it('fails closed instead of regenerating identities from a sidecar with trailing garbage', async () => {
        const root = await createRoot();
        const workingCopyPath = join(root, 'working.pdf');
        await Promise.all([
            writeFile(workingCopyPath, '%PDF fixture'),
            writeFile(`${workingCopyPath}.evb-pages.json`, `${validSidecar()}\ngarbage`),
        ]);

        await expect(readPageIdentity(workingCopyPath, 1, 3)).rejects.toMatchObject({code: 'PAGE_IDENTITY_SIDECAR_CORRUPT'});
    });
});
