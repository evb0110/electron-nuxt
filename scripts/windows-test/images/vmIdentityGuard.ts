import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isVmUuid } from '@scripts/windows-test/contracts/windowsTestContracts';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import type { IUtmVmListEntry } from '@scripts/windows-test/host/utmctlClient';

export interface IWindowsTestDestructiveTarget {
    vmId: string;
    bundlePath: string;
}

export interface IWindowsTestDestructivePolicy {
    allowedTestVmIds: readonly string[];
    goldenVmId: string;
    personalVmIdsDenied: readonly string[];
    testImageRoot: string;
}

export const windowsTestIdentityRefusals = [
    'vm-id-not-a-uuid',
    'vm-id-not-allowlisted',
    'vm-id-is-golden-image',
    'vm-id-denied',
    'bundle-path-unresolved',
    'bundle-path-outside-test-image-root',
    'clone-diff-ambiguous',
] as const;

export type TWindowsTestIdentityRefusal = typeof windowsTestIdentityRefusals[number];

export class WindowsTestIdentityGuardError extends Error {
    readonly refusal: TWindowsTestIdentityRefusal;

    constructor(refusal: TWindowsTestIdentityRefusal, message: string) {
        super(message);
        this.name = 'WindowsTestIdentityGuardError';
        this.refusal = refusal;
    }
}

export interface IWindowsTestIdentityGuardDependencies {resolvePath(target: string): Promise<string>;}

export const nodeIdentityGuardDependencies: IWindowsTestIdentityGuardDependencies = {resolvePath: target => realpath(target)};

export function destructivePolicyFromConfig(config: IWindowsTestHostConfig): IWindowsTestDestructivePolicy {
    return {
        allowedTestVmIds: config.allowedTestVmIds,
        goldenVmId: config.goldenVmId,
        personalVmIdsDenied: config.personalVmIdsDenied,
        testImageRoot: config.testImageRoot,
    };
}

// A clone registers a UUID that no static allowlist can contain, so the
// coordinator widens the policy with the single new UUID it observed from its
// own clone call. The golden and denied identities stay refused regardless.
export function withOwnedCloneAllowlisted(
    policy: IWindowsTestDestructivePolicy,
    clonedVmId: string,
): IWindowsTestDestructivePolicy {
    const normalized = clonedVmId.toLowerCase();
    if (!isVmUuid(normalized)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-not-a-uuid',
            `Refusing to own clone "${clonedVmId}": it is not a VM UUID.`,
        );
    }
    if (normalized === policy.goldenVmId.toLowerCase()) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-is-golden-image',
            'Refusing to own the golden image UUID as a working clone.',
        );
    }
    if (policy.personalVmIdsDenied.some(denied => denied.toLowerCase() === normalized)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-denied',
            'Refusing to own a denied VM UUID as a working clone.',
        );
    }
    return {
        ...policy,
        allowedTestVmIds: [
            ...policy.allowedTestVmIds,
            normalized,
        ],
    };
}

function isInside(parent: string, child: string) {
    const relative = path.relative(parent, child);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function assertDestructiveTarget(
    target: IWindowsTestDestructiveTarget,
    policy: IWindowsTestDestructivePolicy,
    dependencies: IWindowsTestIdentityGuardDependencies = nodeIdentityGuardDependencies,
) {
    const vmId = target.vmId.toLowerCase();
    if (!isVmUuid(vmId)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-not-a-uuid',
            `Refusing a destructive operation on "${target.vmId}": display names and partial identifiers are never accepted.`,
        );
    }
    if (vmId === policy.goldenVmId.toLowerCase()) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-is-golden-image',
            'Refusing a destructive operation on the golden image; it stays stopped and immutable.',
        );
    }
    if (policy.personalVmIdsDenied.some(denied => denied.toLowerCase() === vmId)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-denied',
            'Refusing a destructive operation on a denied VM UUID.',
        );
    }
    if (!policy.allowedTestVmIds.some(allowed => allowed.toLowerCase() === vmId)) {
        throw new WindowsTestIdentityGuardError(
            'vm-id-not-allowlisted',
            'Refusing a destructive operation on a VM UUID that is not in the configured test allowlist.',
        );
    }

    let resolvedTarget: string;
    let resolvedRoot: string;
    try {
        resolvedRoot = await dependencies.resolvePath(policy.testImageRoot);
        resolvedTarget = await dependencies.resolvePath(target.bundlePath);
    } catch (error) {
        throw new WindowsTestIdentityGuardError(
            'bundle-path-unresolved',
            `Refusing a destructive operation: the VM bundle path could not be resolved (${String(error)}).`,
        );
    }
    if (!isInside(resolvedRoot, resolvedTarget)) {
        throw new WindowsTestIdentityGuardError(
            'bundle-path-outside-test-image-root',
            'Refusing a destructive operation: the resolved VM bundle path is outside the configured test image root.',
        );
    }

    return {
        vmId,
        bundlePath: resolvedTarget,
    };
}

export function selectClonedVmId(
    before: readonly IUtmVmListEntry[],
    after: readonly IUtmVmListEntry[],
) {
    const known = new Set(before.map(entry => entry.uuid.toLowerCase()));
    const added = after
        .map(entry => entry.uuid.toLowerCase())
        .filter(uuid => !known.has(uuid));
    const unique = [...new Set(added)];
    if (unique.length !== 1) {
        throw new WindowsTestIdentityGuardError(
            'clone-diff-ambiguous',
            `Refusing an ambiguous clone result: expected exactly one new registered VM UUID, saw ${unique.length}.`,
        );
    }
    const cloned = unique[0];
    if (cloned === undefined || !isVmUuid(cloned)) {
        throw new WindowsTestIdentityGuardError(
            'clone-diff-ambiguous',
            'Refusing an ambiguous clone result: the new registration is not a VM UUID.',
        );
    }
    return cloned;
}
