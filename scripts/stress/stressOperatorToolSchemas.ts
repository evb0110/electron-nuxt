import {
    DEFAULT_MAX_TOOL_CALLS_PER_TURN,
    FREEZE_STREAK_THRESHOLD,
} from '@scripts/stress/stressOperatorConversation';
import type {
    IStressTaskCard,
    TStressOperatorProfile,
} from '@scripts/stress/stressTypes';

/**
 * Plain JSON tool definitions (no zod: the root workspace cannot resolve it).
 * Shapes mirror `.devkit/analysis/stress-research/03-operator-design.md`.
 */
export interface IStressCustomToolDefinition {
    name: string;
    description: string;
    input_schema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
}

export const COMPUTER_TOOLSET_TYPE = 'computer_toolset_20260801';
export const COMPUTER_TOOLSET_NAME = 'computer';

export const COMPUTER_TOOLSET_MEMBERS = [
    'screenshot',
    'zoom',
    'left_click',
    'right_click',
    'middle_click',
    'double_click',
    'triple_click',
    'left_click_drag',
    'mouse_move',
    'left_mouse_down',
    'left_mouse_up',
    'cursor_position',
    'scroll',
    'type',
    'key',
    'hold_key',
    'wait',
] as const;

export type TComputerToolsetMember = typeof COMPUTER_TOOLSET_MEMBERS[number];

export function isComputerToolsetMember(name: string): name is TComputerToolsetMember {
    return (COMPUTER_TOOLSET_MEMBERS as readonly string[]).includes(name);
}

export const SHARED_TOOLS: IStressCustomToolDefinition[] = [
    {
        name: 'open_document',
        description: 'Open one of the task-card files in the viewer. Waits until the document has rendered its first page or an open error is shown. Only paths listed in the task card are allowed.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Absolute path exactly as written in the task card.',
                },
                in_new_tab: {
                    type: 'boolean',
                    description: 'Open in a new tab instead of replacing the active tab.',
                    default: false,
                },
            },
            required: ['path'],
            additionalProperties: false,
        },
    },
    {
        name: 'wait_for_idle',
        description: 'Block until the viewer reports it is idle (no document opening, saving or page operation in flight). Use after opening, saving or heavy navigation before taking a screenshot.',
        input_schema: {
            type: 'object',
            properties: {timeout_ms: {
                type: 'integer',
                minimum: 1000,
                maximum: 120000,
                default: 30000,
            }},
            additionalProperties: false,
        },
    },
    {
        name: 'app_state',
        description: 'Return structured viewer state: document name, current/total page, zoom, tabs, unsaved changes, readiness, visible dialogs and messages. Cheaper than a screenshot; use it to verify a step.',
        input_schema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'report',
        description: 'Finish the task. Call exactly once, as the last tool call, with what you completed and any problem you saw.',
        input_schema: {
            type: 'object',
            properties: {
                outcome: {
                    type: 'string',
                    enum: [
                        'completed',
                        'blocked',
                        'app_broken',
                    ],
                },
                steps_done: {
                    type: 'array',
                    items: {type: 'string'},
                },
                problem: {
                    type: 'string',
                    description: 'What went wrong, or empty when nothing did.',
                },
                slowest_action: {
                    type: 'string',
                    description: 'Which action felt slowest and roughly how long it took.',
                },
                final_page: {
                    type: 'integer',
                    minimum: 0,
                },
            },
            required: [
                'outcome',
                'steps_done',
            ],
            additionalProperties: false,
        },
    },
];

export const SEMANTIC_TOOLS: IStressCustomToolDefinition[] = [
    {
        name: 'observe',
        description: 'List the visible controls (buttons, inputs, tabs, links) with short ids and labels, plus the viewer state. Ids are only valid until the next state-changing call.',
        input_schema: {
            type: 'object',
            properties: {with_image: {
                type: 'boolean',
                description: 'Also attach a screenshot.',
                default: false,
            }},
            additionalProperties: false,
        },
    },
    {
        name: 'click',
        description: 'Click a control by the id returned from observe.',
        input_schema: {
            type: 'object',
            properties: {
                id: {type: 'string'},
                button: {
                    type: 'string',
                    enum: [
                        'left',
                        'right',
                    ],
                    default: 'left',
                },
                count: {
                    type: 'integer',
                    enum: [
                        1,
                        2,
                    ],
                    default: 1,
                },
            },
            required: ['id'],
            additionalProperties: false,
        },
    },
    {
        name: 'type_text',
        description: 'Type text into the focused control.',
        input_schema: {
            type: 'object',
            properties: {
                text: {type: 'string'},
                clear_first: {
                    type: 'boolean',
                    default: false,
                },
            },
            required: ['text'],
            additionalProperties: false,
        },
    },
    {
        name: 'press_key',
        description: 'Press a key or chord, e.g. "Enter", "PageDown", "Meta+s", "Control+f".',
        input_schema: {
            type: 'object',
            properties: {
                key: {type: 'string'},
                repeat: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 50,
                    default: 1,
                },
            },
            required: ['key'],
            additionalProperties: false,
        },
    },
    {
        name: 'scroll',
        description: 'Scroll the document viewport by wheel notches (about 100 px each).',
        input_schema: {
            type: 'object',
            properties: {
                direction: {
                    type: 'string',
                    enum: [
                        'up',
                        'down',
                    ],
                },
                amount: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 200,
                    default: 5,
                },
                repeat: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 20,
                    default: 1,
                },
            },
            required: ['direction'],
            additionalProperties: false,
        },
    },
    {
        name: 'drag',
        description: 'Drag from one control to another control or by an offset in pixels.',
        input_schema: {
            type: 'object',
            properties: {
                from_id: {type: 'string'},
                to_id: {type: 'string'},
                to_offset: {
                    type: 'object',
                    properties: {
                        dx: {type: 'number'},
                        dy: {type: 'number'},
                    },
                    required: [
                        'dx',
                        'dy',
                    ],
                },
                steps: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 60,
                    default: 10,
                },
            },
            required: ['from_id'],
            additionalProperties: false,
        },
    },
];

export function buildOperatorToolDefinitions(profile: TStressOperatorProfile) {
    return profile === 'pixel'
        ? SHARED_TOOLS
        : [
            ...SEMANTIC_TOOLS,
            ...SHARED_TOOLS,
        ];
}

export const MAX_TURNS_PLACEHOLDER = '{{MAX_TURNS}}';
export const MAX_TOOL_CALLS_PLACEHOLDER = '{{MAX_TOOL_CALLS}}';
export const FREEZE_STREAK_PLACEHOLDER = '{{FREEZE_STREAK}}';

const SYSTEM_PROMPT_TEMPLATE = `You are a test operator for a desktop PDF viewer. You control the app through tools and follow the task card exactly.

Rules
1. Open only the files listed in the task card, through the open_document tool. Never use File, Open, Save As or Print dialogs.
2. Never open Settings or Preferences.
3. If an error dialog appears, do not dismiss it. Describe it in your report and continue with the next step if the app still responds.
4. Do not save unless the task card tells you to.
5. After every action that changes the screen, look before acting again: take a screenshot or call app_state. Do not guess coordinates from memory.
6. If the same screenshot repeats ${FREEZE_STREAK_PLACEHOLDER} times after actions, the app is likely frozen: call wait_for_idle once, then report outcome "app_broken" if nothing changed.
7. Keep at most ${MAX_TOOL_CALLS_PLACEHOLDER} tool calls per message. Prefer app_state over screenshots when you only need the page number or zoom.
8. You have at most ${MAX_TURNS_PLACEHOLDER} turns. Call report exactly once as the last thing you do, even when blocked.
9. Be honest in the report: list only steps you verified on screen.`;

export function buildOperatorSystemPrompt(profile: TStressOperatorProfile, maxTurns: number, maxToolCallsPerTurn = DEFAULT_MAX_TOOL_CALLS_PER_TURN) {
    const profileNote = profile === 'pixel'
        ? '\nYou see the screen through screenshots (1280x800). Click coordinates are screenshot pixels.'
        : '\nYou do not see pixels. Call observe to list controls with ids, then act on ids. Ask for with_image only when labels are not enough.';
    const prompt = SYSTEM_PROMPT_TEMPLATE
        .replace(MAX_TURNS_PLACEHOLDER, String(maxTurns))
        .replace(MAX_TOOL_CALLS_PLACEHOLDER, String(maxToolCallsPerTurn))
        .replace(FREEZE_STREAK_PLACEHOLDER, String(FREEZE_STREAK_THRESHOLD));
    return `${prompt}${profileNote}`;
}

export function buildOperatorTaskCard(scenarioId: string, card: IStressTaskCard, filePaths: string[], maxTurns: number) {
    const lines = [
        `TASK ${scenarioId}`,
        `Goal: ${card.goal}`,
        'Files:',
        ...filePaths.map((path, index) => `  ${index + 1}. ${path}`),
        'Steps:',
        ...card.steps.map((step, index) => `  ${index + 1}. ${step}`),
        `Pace: ${card.pace}`,
        `Done when: ${card.doneWhen}`,
        `Budget: ${maxTurns} turns.`,
        'Do not:',
        ...card.doNot.map(item => `  - ${item}`),
    ];
    return lines.join('\n');
}
