import {
    mkdir,
    mkdtemp,
    rm,
    symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertDestructiveTarget,
    destructivePolicyFromConfig,
    selectClonedVmId,
    withOwnedCloneAllowlisted,
} from '@scripts/windows-test/images/vmIdentityGuard';
import type {
    IWindowsTestDestructivePolicy ,
    WindowsTestIdentityGuardError,
} from '@scripts/windows-test/images/vmIdentityGuard';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';

const ALLOWED_VM_ID = '11111111-2222-4333-8444-555555555555';
const GOLDEN_VM_ID = '22222222-3333-4444-8555-666666666666';
const PERSONAL_VM_ID = '99999999-8888-4777-8666-555555555555';
const CLONE_VM_ID = '33333333-4444-4555-8666-777777777777';

function listEntry(uuid: string, name: string) {
    return {
        uuid,
        status: 'stopped',
        name,
    };
}

describe('destructive VM identity guard', () => {
    let baseRoot = '';
    let imageRoot = '';
    let outsideRoot = '';
    let policy: IWindowsTestDestructivePolicy;

    beforeEach(async () => {
        baseRoot = await mkdtemp(path.join(tmpdir(), 'evb-windows-images-'));
        imageRoot = path.join(baseRoot, 'images');
        outsideRoot = path.join(baseRoot, 'personal');
        await mkdir(imageRoot, {recursive: true});
        await mkdir(outsideRoot, {recursive: true});
        await mkdir(path.join(imageRoot, 'clone.utm'), {recursive: true});
        await mkdir(path.join(outsideRoot, 'Personal Windows.utm'), {recursive: true});
        policy = {
            allowedTestVmIds: [ALLOWED_VM_ID],
            goldenVmId: GOLDEN_VM_ID,
            personalVmIdsDenied: [PERSONAL_VM_ID],
            testImageRoot: imageRoot,
        };
    });

    afterEach(async () => {
        if (baseRoot === '') {
            return;
        }
        await rm(baseRoot, {
            force: true,
            recursive: true,
        });
        baseRoot = '';
    });

    it('accepts an allowlisted VM whose bundle resolves inside the test image root', async () => {
        await expect(assertDestructiveTarget(
            {
                vmId: ALLOWED_VM_ID.toUpperCase(),
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
        )).resolves.toMatchObject({vmId: ALLOWED_VM_ID});
    });

    it('refuses a personal VM by UUID', async () => {
        const error = await assertDestructiveTarget(
            {
                vmId: PERSONAL_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('vm-id-denied');
    });

    it('refuses a personal VM by path even when the UUID is allowlisted', async () => {
        const error = await assertDestructiveTarget(
            {
                vmId: ALLOWED_VM_ID,
                bundlePath: path.join(outsideRoot, 'Personal Windows.utm'),
            },
            policy,
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('bundle-path-outside-test-image-root');
    });

    it('follows symlinks before deciding that a bundle is inside the root', async () => {
        await symlink(path.join(outsideRoot, 'Personal Windows.utm'), path.join(imageRoot, 'escape.utm'));

        const error = await assertDestructiveTarget(
            {
                vmId: ALLOWED_VM_ID,
                bundlePath: path.join(imageRoot, 'escape.utm'),
            },
            policy,
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('bundle-path-outside-test-image-root');
    });

    it('never accepts a display name in place of a UUID', async () => {
        const error = await assertDestructiveTarget(
            {
                vmId: 'Windows 11 Test',
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('vm-id-not-a-uuid');
    });

    it('refuses the golden image and any UUID outside the allowlist', async () => {
        await expect(assertDestructiveTarget(
            {
                vmId: GOLDEN_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
        )).rejects.toThrow(/golden image/u);

        const error = await assertDestructiveTarget(
            {
                vmId: CLONE_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            policy,
        ).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestIdentityGuardError).refusal).toBe('vm-id-not-allowlisted');
    });

    it('widens the allowlist only with the clone it just observed', async () => {
        const widened = withOwnedCloneAllowlisted(policy, CLONE_VM_ID);

        await expect(assertDestructiveTarget(
            {
                vmId: CLONE_VM_ID,
                bundlePath: path.join(imageRoot, 'clone.utm'),
            },
            widened,
        )).resolves.toMatchObject({vmId: CLONE_VM_ID});
        expect(() => withOwnedCloneAllowlisted(policy, GOLDEN_VM_ID)).toThrow(/golden/u);
        expect(() => withOwnedCloneAllowlisted(policy, PERSONAL_VM_ID)).toThrow(/denied/u);
    });

    it('derives the policy from the host configuration', () => {
        const config = {
            testImageRoot: '/images',
            allowedTestVmIds: [ALLOWED_VM_ID],
            goldenVmId: GOLDEN_VM_ID,
            personalVmIdsDenied: [PERSONAL_VM_ID],
        } as IWindowsTestHostConfig;

        expect(destructivePolicyFromConfig(config)).toMatchObject({
            goldenVmId: GOLDEN_VM_ID,
            testImageRoot: '/images',
        });
    });
});

describe('clone list difference', () => {
    it('accepts exactly one new registered UUID', () => {
        expect(selectClonedVmId(
            [listEntry(GOLDEN_VM_ID, 'golden')],
            [
                listEntry(GOLDEN_VM_ID, 'golden'),
                listEntry(CLONE_VM_ID, 'evb-win-test-clone'),
            ],
        )).toBe(CLONE_VM_ID);
    });

    it('refuses an ambiguous clone result', () => {
        expect(() => selectClonedVmId([listEntry(GOLDEN_VM_ID, 'golden')], [listEntry(GOLDEN_VM_ID, 'golden')]))
            .toThrow(/exactly one new registered VM UUID/u);
        expect(() => selectClonedVmId(
            [listEntry(GOLDEN_VM_ID, 'golden')],
            [
                listEntry(GOLDEN_VM_ID, 'golden'),
                listEntry(CLONE_VM_ID, 'evb-win-test-clone'),
                listEntry(ALLOWED_VM_ID, 'someone else clone'),
            ],
        )).toThrow(/exactly one new registered VM UUID/u);
    });
});
