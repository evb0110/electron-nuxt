import { AUTOMATION_EXTRA_CHROMIUM_SWITCHES_ENV } from '@scripts/electron-run/electronRunLaunchConfig';
import type {
    IStressHostProfile,
    TStressHostProfileId,
} from '@scripts/stress/stressTypes';

const GIB = 1024 * 1024 * 1024;

const SCREENSHOT_METRICS = {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
};

/**
 * Switches shared by every "slow" profile. The heap cap makes memory
 * pressure reproducible, the renderer limit forces tabs to share one process
 * like a low-RAM machine, and the fixed scale factor keeps screenshot
 * coordinates equal to CSS pixels for the operator.
 */
const SLOW_RENDERER_SWITCHES = [
    '--force-device-scale-factor=1',
    '--js-flags=--max-old-space-size=1024',
    '--renderer-process-limit=1',
];

const NO_CONSTRAINT = {
    rendererSlowdownMin: 1,
    rendererSlowdownMax: 1.6,
    jsHeapSizeLimitMaxBytes: null,
    expectedTier: null,
};

export const STRESS_HOST_PROFILES: Record<TStressHostProfileId, IStressHostProfile> = {
    'baseline': {
        id: 'baseline',
        label: 'BASELINE',
        description: 'Unconstrained host; reference numbers for regression comparison.',
        chromiumSwitches: [],
        env: {},
        cpuThrottlingRate: 1,
        deviceMetrics: SCREENSHOT_METRICS,
        hostConstraint: null,
        calibration: NO_CONSTRAINT,
    },
    'slow-a': {
        id: 'slow-a',
        label: 'SLOW-A',
        description: 'Renderer main thread throttled 4x, 1 GiB V8 heap, single renderer process.',
        chromiumSwitches: SLOW_RENDERER_SWITCHES,
        env: {},
        cpuThrottlingRate: 4,
        deviceMetrics: SCREENSHOT_METRICS,
        hostConstraint: null,
        calibration: {
            rendererSlowdownMin: 3,
            rendererSlowdownMax: 5.5,
            jsHeapSizeLimitMaxBytes: 1.25 * GIB,
            expectedTier: null,
        },
    },
    'slow-a-gpu': {
        id: 'slow-a-gpu',
        label: 'SLOW-A-GPU',
        description: 'SLOW-A plus software compositing and rasterization (no GPU acceleration).',
        chromiumSwitches: [
            ...SLOW_RENDERER_SWITCHES,
            '--disable-gpu-compositing',
            '--disable-gpu-rasterization',
        ],
        env: {},
        cpuThrottlingRate: 4,
        deviceMetrics: SCREENSHOT_METRICS,
        hostConstraint: null,
        calibration: {
            rendererSlowdownMin: 3,
            rendererSlowdownMax: 5.5,
            jsHeapSizeLimitMaxBytes: 1.25 * GIB,
            expectedTier: null,
        },
    },
    'slow-b': {
        id: 'slow-b',
        label: 'SLOW-B',
        description: 'Whole process tree under a Linux cgroup (1 CPU, 3 GiB); CDP throttling stays off so workers and the main process slow down too.',
        chromiumSwitches: SLOW_RENDERER_SWITCHES,
        env: {},
        cpuThrottlingRate: 1,
        deviceMetrics: SCREENSHOT_METRICS,
        hostConstraint: {
            platform: 'linux',
            commandPrefix: [
                'systemd-run',
                '--user',
                '--scope',
                '-p',
                'CPUQuota=100%',
                '-p',
                'MemoryMax=3G',
            ],
            description: 'Launch the runner itself under systemd-run so Electron inherits the cgroup.',
            expectedCpus: 1,
            expectedMemoryBytes: 3 * GIB,
        },
        calibration: {
            rendererSlowdownMin: 1,
            rendererSlowdownMax: 1.6,
            jsHeapSizeLimitMaxBytes: 1.25 * GIB,
            expectedTier: null,
        },
    },
    'slow-c': {
        id: 'slow-c',
        label: 'SLOW-C',
        description: 'Hosted CI runner approximation: 2x throttle, no heap cap, no GPU.',
        chromiumSwitches: [
            '--force-device-scale-factor=1',
            '--disable-gpu-compositing',
        ],
        env: {},
        cpuThrottlingRate: 2,
        deviceMetrics: SCREENSHOT_METRICS,
        hostConstraint: null,
        calibration: {
            rendererSlowdownMin: 1.6,
            rendererSlowdownMax: 2.8,
            jsHeapSizeLimitMaxBytes: null,
            expectedTier: null,
        },
    },
    'forced-low': {
        id: 'forced-low',
        label: 'FORCED-LOW',
        description: 'App-level low tier via EVB_TEST_PERFORMANCE_MODE=low on an otherwise unconstrained host.',
        chromiumSwitches: [],
        env: {EVB_TEST_PERFORMANCE_MODE: 'low'},
        cpuThrottlingRate: 1,
        deviceMetrics: SCREENSHOT_METRICS,
        hostConstraint: null,
        calibration: {
            rendererSlowdownMin: 1,
            rendererSlowdownMax: 1.6,
            jsHeapSizeLimitMaxBytes: null,
            expectedTier: 'low',
        },
    },
};

export const STRESS_HOST_PROFILE_IDS = Object.keys(STRESS_HOST_PROFILES) as TStressHostProfileId[];

export function isStressHostProfileId(value: string): value is TStressHostProfileId {
    return Object.hasOwn(STRESS_HOST_PROFILES, value);
}

export function resolveStressHostProfile(id: string) {
    if (!isStressHostProfileId(id)) {
        throw new Error(`Unknown stress host profile '${id}'. Known: ${STRESS_HOST_PROFILE_IDS.join(', ')}`);
    }
    return STRESS_HOST_PROFILES[id];
}

/**
 * Environment handed to the Electron E2E session. Chromium switches travel
 * through the launch-config hook because `buildElectronAutomationArgs` is the
 * only place that assembles the Electron argv.
 */
export function buildStressProfileSessionEnv(profile: IStressHostProfile) {
    const env: Record<string, string> = { ...profile.env };
    if (profile.chromiumSwitches.length > 0) {
        env[AUTOMATION_EXTRA_CHROMIUM_SWITCHES_ENV] = profile.chromiumSwitches.join(' ');
    }
    return env;
}

export function describeStressHostProfile(profile: IStressHostProfile) {
    const lines = [
        `${profile.label} (${profile.id}): ${profile.description}`,
        `  chromium switches: ${profile.chromiumSwitches.length > 0 ? profile.chromiumSwitches.join(' ') : '(none)'}`,
        `  cpu throttling rate: ${profile.cpuThrottlingRate}`,
        `  viewport: ${profile.deviceMetrics.width}x${profile.deviceMetrics.height} @${profile.deviceMetrics.deviceScaleFactor}`,
    ];
    const envKeys = Object.keys(profile.env);
    if (envKeys.length > 0) {
        lines.push(`  env: ${envKeys.map(key => `${key}=${profile.env[key] ?? '<missing>'}`).join(' ')}`);
    }
    if (profile.hostConstraint) {
        lines.push(`  host wrapper (${profile.hostConstraint.platform}): ${profile.hostConstraint.commandPrefix.join(' ')} <runner>`);
    }
    return lines.join('\n');
}
