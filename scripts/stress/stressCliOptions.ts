import { STRESS_HOST_PROFILE_IDS } from '@scripts/stress/stressHostProfiles';
import { DEFAULT_STRESS_OPERATOR_MODEL } from '@scripts/stress/stressOperatorCost';
import type {
    TStressHostProfileId,
    TStressOperatorProfile,
} from '@scripts/stress/stressTypes';

export interface IStressCliOptions {
    list: boolean;
    dryRun: boolean;
    scenarioIds: string[];
    tags: string[];
    kind: 'deterministic' | 'operator' | null;
    profile: TStressHostProfileId;
    model: string;
    operatorProfile: TStressOperatorProfile;
    thinking: boolean;
    out: string | null;
    updateBaseline: boolean;
    fixturesOnly: boolean;
    calibrateOnly: boolean;
    maxRunCostUsd: number | null;
    help: boolean;
}

export const STRESS_CLI_USAGE = `Usage: pnpm run stress -- [options]

  --list                    print scenarios, host profiles and fixtures, then exit
  --dry-run                 resolve the plan (fixtures, profile, model) without launching Electron
  --scenario <id>           run one scenario (repeatable; comma lists accepted)
  --tag <tag>               run every scenario carrying the tag (repeatable)
  --kind deterministic|operator
  --profile <id>            host profile: ${STRESS_HOST_PROFILE_IDS.join(', ')} (default baseline)
  --model <id>              operator model (default ${DEFAULT_STRESS_OPERATOR_MODEL})
  --operator pixel|semantic operator tool profile (default pixel)
  --thinking                enable adaptive thinking for the operator model
  --out <dir>               run directory (default .devkit/stress/runs/<run-id>)
  --update-baseline         write docs/benchmarks/stress/<profile>.json when every scenario passed
  --fixtures-only           generate fixtures and exit
  --calibrate-only          launch once, run the calibration probe, and exit
  --max-run-cost <usd>      override the whole-run operator spend cap
  --help`;

function splitList(value: string) {
    return value.split(',').map(part => part.trim()).filter(part => part.length > 0);
}

function readValue(argv: readonly string[], index: number, flag: string) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} needs a value`);
    }
    return value;
}

/** Pure argv parser; throws on unknown flags so typos never silently run the default plan. */
export function parseStressCliOptions(argv: readonly string[]): IStressCliOptions {
    const options: IStressCliOptions = {
        list: false,
        dryRun: false,
        scenarioIds: [],
        tags: [],
        kind: null,
        profile: 'baseline',
        model: DEFAULT_STRESS_OPERATOR_MODEL,
        operatorProfile: 'pixel',
        thinking: false,
        out: null,
        updateBaseline: false,
        fixturesOnly: false,
        calibrateOnly: false,
        maxRunCostUsd: null,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? '';
        const [
            flag,
            inlineValue,
        ] = arg.includes('=') ? [
            arg.slice(0, arg.indexOf('=')),
            arg.slice(arg.indexOf('=') + 1),
        ] : [
            arg,
            undefined,
        ];
        const takeValue = () => {
            if (inlineValue !== undefined) {
                return inlineValue;
            }
            const value = readValue(argv, index, flag);
            index += 1;
            return value;
        };
        switch (flag) {
            case '--list':
                options.list = true;
                break;
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--scenario':
                options.scenarioIds.push(...splitList(takeValue()));
                break;
            case '--tag':
                options.tags.push(...splitList(takeValue()));
                break;
            case '--kind': {
                const kind = takeValue();
                if (kind !== 'deterministic' && kind !== 'operator') {
                    throw new Error('--kind must be deterministic or operator');
                }
                options.kind = kind;
                break;
            }
            case '--profile': {
                const profile = takeValue();
                if (!(STRESS_HOST_PROFILE_IDS as string[]).includes(profile)) {
                    throw new Error(`unknown --profile ${profile}; expected one of ${STRESS_HOST_PROFILE_IDS.join(', ')}`);
                }
                options.profile = profile as TStressHostProfileId;
                break;
            }
            case '--model':
                options.model = takeValue();
                break;
            case '--operator': {
                const operator = takeValue();
                if (operator !== 'pixel' && operator !== 'semantic') {
                    throw new Error('--operator must be pixel or semantic');
                }
                options.operatorProfile = operator;
                break;
            }
            case '--thinking':
                options.thinking = true;
                break;
            case '--out':
                options.out = takeValue();
                break;
            case '--update-baseline':
                options.updateBaseline = true;
                break;
            case '--fixtures-only':
                options.fixturesOnly = true;
                break;
            case '--calibrate-only':
                options.calibrateOnly = true;
                break;
            case '--max-run-cost': {
                const parsed = Number(takeValue());
                if (!Number.isFinite(parsed) || parsed < 0) {
                    throw new Error('--max-run-cost must be a non-negative number');
                }
                options.maxRunCostUsd = parsed;
                break;
            }
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                throw new Error(`unknown option ${arg}\n${STRESS_CLI_USAGE}`);
        }
    }
    return options;
}

export interface IStressReplayCliOptions {
    actionsPath: string | null;
    profile: TStressHostProfileId;
    scenarioId: string | null;
    help: boolean;
}

export const STRESS_REPLAY_USAGE = `Usage: pnpm run stress:replay -- --actions <path/to/actions.jsonl> [--profile <id>] [--scenario <id>]

Replays a recorded operator session against a fresh app and reports where
the structured app state diverges from the recording.`;

export function parseStressReplayCliOptions(argv: readonly string[]): IStressReplayCliOptions {
    const options: IStressReplayCliOptions = {
        actionsPath: null,
        profile: 'baseline',
        scenarioId: null,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? '';
        const [
            flag,
            inlineValue,
        ] = arg.includes('=') ? [
            arg.slice(0, arg.indexOf('=')),
            arg.slice(arg.indexOf('=') + 1),
        ] : [
            arg,
            undefined,
        ];
        const takeValue = () => {
            if (inlineValue !== undefined) {
                return inlineValue;
            }
            const value = readValue(argv, index, flag);
            index += 1;
            return value;
        };
        switch (flag) {
            case '--actions':
                options.actionsPath = takeValue();
                break;
            case '--profile': {
                const profile = takeValue();
                if (!(STRESS_HOST_PROFILE_IDS as string[]).includes(profile)) {
                    throw new Error(`unknown --profile ${profile}`);
                }
                options.profile = profile as TStressHostProfileId;
                break;
            }
            case '--scenario':
                options.scenarioId = takeValue();
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                throw new Error(`unknown option ${arg}\n${STRESS_REPLAY_USAGE}`);
        }
    }
    return options;
}
