#!/usr/bin/env node

import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
    getRequiredArtifactPatterns,
    getLocalReleaseTargets,
    getSupplementalReleaseAssetNames,
} from './policy.mjs';
import {listWorkflowRuns} from './github-workflow-run.mjs';
import {RELEASE_TAG_PATTERN} from './releaseTag.mjs';
import {
    errorMessage,
    getExitStatus,
    run,
} from './shared.mjs';

const MIRROR_CHANNEL_KEY = 'evb-viewer/channels/stable.json';
const CORE_TARGETS = [
    {
        arch: 'arm64',
        label: 'mac-arm64',
        platform: 'darwin',
    },
    {
        arch: 'x64',
        label: 'linux-x64',
        platform: 'linux',
    },
    {
        arch: 'arm64',
        label: 'linux-arm64',
        platform: 'linux',
    },
    {
        arch: 'x64',
        label: 'win-x64',
        platform: 'win32',
    },
];

function isNotFoundError(error) {
    const status = getExitStatus(error);
    const message = errorMessage(error);

    return status === 1 && (
        message.length === 0
        || /not found|does not exist|could not find|HTTP 404/iu.test(message)
    );
}

function readTagState(tag, runCommand) {
    try {
        runCommand('gh', [
            'api',
            '-H',
            'Accept: application/vnd.github+json',
            `repos/{owner}/{repo}/git/ref/tags/${tag}`,
        ]);
        return {
            exists: true,
            error: null,
        };
    } catch (error) {
        if (isNotFoundError(error)) {
            return {
                exists: false,
                error: null,
            };
        }

        return {
            exists: false,
            error: errorMessage(error),
        };
    }
}

function readReleaseState(tag, runCommand) {
    try {
        const payload = runCommand('gh', [
            'release',
            'view',
            tag,
            '--json',
            'isDraft,publishedAt,assets,tagName',
        ]);
        const release = JSON.parse(payload);
        const assets = Array.isArray(release.assets)
            ? release.assets
                .map(asset => asset?.name)
                .filter(name => typeof name === 'string')
            : [];

        return {
            assets,
            error: null,
            exists: true,
            isDraft: release.isDraft === true,
            publishedAt: typeof release.publishedAt === 'string' ? release.publishedAt : null,
            tagName: typeof release.tagName === 'string' ? release.tagName : tag,
        };
    } catch (error) {
        if (isNotFoundError(error)) {
            return {
                assets: [],
                error: null,
                exists: false,
                isDraft: false,
                publishedAt: null,
                tagName: tag,
            };
        }

        return {
            assets: [],
            error: errorMessage(error),
            exists: false,
            isDraft: false,
            publishedAt: null,
            tagName: tag,
        };
    }
}

function patternText(pattern) {
    return pattern instanceof RegExp ? pattern.toString() : String(pattern);
}

function getCoreAssetRequirements({
    env,
    getLocalReleaseTargetsFn,
    getRequiredArtifactPatternsFn,
}) {
    const policyEnv = {
        ...env,
        // The status command checks the public release matrix. Local signing
        // credentials must not make the macOS ZIP optional in that report.
        EVB_RELEASE_HAS_MAC_SIGNING: env.EVB_RELEASE_HAS_MAC_SIGNING ?? 'true',
        EVB_RELEASE_HAS_WINDOWS_SIGNING: env.EVB_RELEASE_HAS_WINDOWS_SIGNING ?? 'true',
    };

    return CORE_TARGETS.flatMap(({
        arch,
        label,
        platform,
    }) => (
        getLocalReleaseTargetsFn({
            arch,
            platform,
        })
            .flatMap(target => getRequiredArtifactPatternsFn(target, policyEnv)
                .map(pattern => ({
                    label: `${label} ${patternText(pattern)}`,
                    pattern,
                })))
    ));
}

function summarizeCoreAssets(assetNames, requirements, supplementalNames) {
    const coreAssetNames = assetNames.filter(name => !supplementalNames.includes(name));
    const present = requirements
        .filter(requirement => coreAssetNames.some(name => requirement.pattern.test(name)))
        .map(requirement => requirement.label);
    const missing = requirements
        .filter(requirement => !coreAssetNames.some(name => requirement.pattern.test(name)))
        .map(requirement => requirement.label);

    return {
        complete: missing.length === 0,
        expected: requirements.map(requirement => requirement.label),
        missing,
        present,
    };
}

function summarizeSupplementalAssets(assetNames, expectedNames) {
    const present = expectedNames.filter(name => assetNames.includes(name));

    return {
        complete: present.length === expectedNames.length,
        expected: [...expectedNames],
        missing: expectedNames.filter(name => !assetNames.includes(name)),
        present,
    };
}

function runMatchesTag(runInfo, tag) {
    const values = [
        runInfo?.displayTitle,
        runInfo?.name,
        runInfo?.workflowName,
        runInfo?.inputs?.tag,
        runInfo?.eventPayload?.inputs?.tag,
    ];

    return values.some(value => {
        if (typeof value !== 'string') {
            return false;
        }

        return value === tag
            || value === `Release ${tag}`
            || value === `Release (${tag})`
            || value.includes(tag);
    });
}

function latestWorkflowRun(tag, workflow, listWorkflowRunsFn, runCommand) {
    let runs;
    try {
        runs = listWorkflowRunsFn(workflow, {runCommand});
    } catch (error) {
        return {
            conclusion: null,
            createdAt: null,
            error: errorMessage(error),
            found: false,
            status: 'unavailable',
            url: '',
        };
    }

    const matchingRuns = (Array.isArray(runs) ? runs : [])
        .filter(runInfo => runMatchesTag(runInfo, tag));
    const latest = matchingRuns.reduce((current, candidate) => {
        if (!current) {
            return candidate;
        }

        const currentTime = Date.parse(String(current.createdAt ?? ''));
        const candidateTime = Date.parse(String(candidate.createdAt ?? ''));
        if (candidateTime !== currentTime) {
            return candidateTime > currentTime ? candidate : current;
        }

        return Number(candidate.databaseId ?? 0) > Number(current.databaseId ?? 0)
            ? candidate
            : current;
    }, null);

    if (!latest) {
        return {
            conclusion: null,
            createdAt: null,
            error: null,
            found: false,
            status: 'not found',
            url: '',
        };
    }

    return {
        conclusion: latest.conclusion ?? null,
        createdAt: latest.createdAt ?? null,
        error: null,
        found: true,
        status: latest.status ?? 'unknown',
        url: latest.url ?? '',
    };
}

function mirrorIsConfigured(env) {
    return [
        'MIRROR_S3_ENDPOINT',
        'MIRROR_S3_BUCKET',
        'MIRROR_S3_ACCESS_KEY_ID',
        'MIRROR_S3_SECRET_KEY',
    ].every(name => typeof env[name] === 'string' && env[name].trim() !== '');
}

function readMirrorChannel({
    env,
    runCommand,
}) {
    const payload = runCommand('aws', [
        's3',
        'cp',
        `s3://${env.MIRROR_S3_BUCKET}/${MIRROR_CHANNEL_KEY}`,
        '-',
        '--endpoint-url',
        env.MIRROR_S3_ENDPOINT,
        '--region',
        env.MIRROR_S3_REGION || 'ru-central1',
    ], {env: {
        ...env,
        AWS_ACCESS_KEY_ID: env.MIRROR_S3_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: env.MIRROR_S3_SECRET_KEY,
    }});
    const channel = JSON.parse(payload);
    const tag = channel.release?.tag ?? channel.tag ?? null;

    return {
        checked: true,
        error: null,
        tag: typeof tag === 'string' ? tag : null,
    };
}

function summarizeMirror(tag, env, runCommand, readMirrorChannelFn) {
    if (!mirrorIsConfigured(env)) {
        return {
            checked: false,
            error: null,
            matchesTag: null,
            tag: null,
        };
    }

    try {
        const mirror = readMirrorChannelFn({
            env,
            runCommand,
        });
        return {
            checked: true,
            error: mirror.error ?? null,
            matchesTag: mirror.tag === tag,
            tag: mirror.tag ?? null,
        };
    } catch (error) {
        return {
            checked: true,
            error: errorMessage(error),
            matchesTag: false,
            tag: null,
        };
    }
}

export function summarizeReleaseStatus(tag, deps = {}) {
    if (!RELEASE_TAG_PATTERN.test(tag)) {
        throw new Error(`Expected a release tag such as v1.2.3, received "${tag}"`);
    }

    const runCommand = deps.runCommand ?? run;
    const env = deps.env ?? process.env;
    const getLocalReleaseTargetsFn = deps.getLocalReleaseTargetsFn ?? getLocalReleaseTargets;
    const getRequiredArtifactPatternsFn = deps.getRequiredArtifactPatternsFn ?? getRequiredArtifactPatterns;
    const getSupplementalReleaseAssetNamesFn = deps.getSupplementalReleaseAssetNamesFn
        ?? getSupplementalReleaseAssetNames;
    const listWorkflowRunsFn = deps.listWorkflowRunsFn ?? listWorkflowRuns;
    const readMirrorChannelFn = deps.readMirrorChannelFn ?? readMirrorChannel;
    const version = tag.slice(1);
    const tagState = deps.readTagStateFn
        ? deps.readTagStateFn(tag, runCommand)
        : readTagState(tag, runCommand);
    const release = deps.readReleaseStateFn
        ? deps.readReleaseStateFn(tag, runCommand)
        : readReleaseState(tag, runCommand);
    const supplementalNames = getSupplementalReleaseAssetNamesFn(version);
    const core = summarizeCoreAssets(
        release.assets,
        getCoreAssetRequirements({
            env,
            getLocalReleaseTargetsFn,
            getRequiredArtifactPatternsFn,
        }),
        supplementalNames,
    );
    const supplemental = summarizeSupplementalAssets(release.assets, supplementalNames);
    const checksumManifestPresent = release.assets.includes('SHA256SUMS');
    const mirror = summarizeMirror(tag, env, runCommand, readMirrorChannelFn);
    const isPublic = release.exists && !release.isDraft;
    const coreComplete = tagState.exists
        && isPublic
        && core.complete
        && checksumManifestPresent
        && (!mirror.checked || mirror.matchesTag);
    const workflows = {
        release: latestWorkflowRun(tag, 'release.yml', listWorkflowRunsFn, runCommand),
        supplemental: latestWorkflowRun(
            tag,
            'release-supplemental.yml',
            listWorkflowRunsFn,
            runCommand,
        ),
    };
    return {
        assets: [...release.assets].sort(),
        checksumManifestPresent,
        core,
        coreComplete,
        isDraft: release.exists ? release.isDraft : null,
        isPublic,
        mirror,
        publishedAt: release.publishedAt,
        releaseExists: release.exists,
        releaseError: release.error,
        releaseTag: release.tagName,
        supplemental,
        supplementalComplete: supplemental.complete,
        tag,
        tagError: tagState.error,
        tagExists: tagState.exists,
        workflows,
    };
}

function formatWorkflow(label, workflow) {
    if (!workflow.found) {
        const detail = workflow.error ? `, ${workflow.error}` : '';
        return `${label}: ${workflow.status}${detail}`;
    }

    const conclusion = workflow.conclusion ? `, conclusion=${workflow.conclusion}` : '';
    return `${label}: ${workflow.status}${conclusion}, ${workflow.url || 'no URL'}`;
}

export function formatReleaseStatus(status) {
    const releaseState = !status.releaseExists
        ? status.releaseError ? `unavailable (${status.releaseError})` : 'missing'
        : status.isDraft ? 'draft' : 'public';
    const publishedAt = status.publishedAt ? `, published_at=${status.publishedAt}` : '';
    const presentAssets = status.assets.length > 0 ? status.assets.join(', ') : '(none)';
    const coreCounts = `${status.core.present.length}/${status.core.expected.length}`;
    const coreMissing = status.core.missing.length > 0
        ? `, missing=${status.core.missing.join('; ')}`
        : '';
    const supplementalCounts = `${status.supplemental.present.length}/${status.supplemental.expected.length}`;
    const supplementalMissing = status.supplemental.missing.length > 0
        ? `, missing=${status.supplemental.missing.join(', ')}`
        : '';
    const mirror = status.mirror.checked
        ? status.mirror.error
            ? `mirror: error (${status.mirror.error})`
            : `mirror: ${status.mirror.tag ?? 'no tag'}${status.mirror.matchesTag ? ' (matches)' : ' (does not match)'}`
        : 'mirror: not checked';

    return [
        `Release status: ${status.tag}`,
        `tag: ${status.tagExists ? 'present' : 'missing'}${status.tagError ? ` (${status.tagError})` : ''}`,
        `release: ${releaseState}${publishedAt}`,
        `assets present: ${presentAssets}`,
        `core assets: ${status.core.complete ? 'complete' : 'incomplete'} (${coreCounts})${coreMissing}`,
        `supplemental assets: ${status.supplemental.complete ? 'complete' : 'incomplete'} (${supplementalCounts})${supplementalMissing}`,
        `checksum manifest: ${status.checksumManifestPresent ? 'present' : 'missing'}`,
        formatWorkflow('release workflow', status.workflows.release),
        formatWorkflow('supplemental workflow', status.workflows.supplemental),
        mirror,
        `core complete and public: ${status.coreComplete ? 'yes' : 'no'}`,
    ].join('\n') + '\n';
}

function readTag() {
    const tag = process.argv[2]?.trim();
    if (!tag) {
        throw new Error('Usage: release-status.mjs <release tag>');
    }

    return tag;
}

async function main() {
    const status = summarizeReleaseStatus(readTag());
    process.stdout.write(formatReleaseStatus(status));
    if (!status.coreComplete) {
        process.exitCode = 1;
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}
