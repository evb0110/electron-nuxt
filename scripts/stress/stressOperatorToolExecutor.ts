import { getErrorMessage } from '@contracts/getErrorMessage';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type {
    ImageBlockParam,
    TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type {
    KeyInput,
    Page,
} from 'puppeteer-core';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import {
    openDjvuInApp,
    openPdfInApp,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    getWorkspaceToolbarSnapshot,
    waitForWorkspaceToolbarIdle,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import { createNewWorkspaceTab } from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    collectStressAppState,
    formatStressAppStateForModel,
} from '@scripts/stress/stressAppState';
import {
    COMPUTER_TOOLSET_NAME,
    isComputerToolsetMember,
} from '@scripts/stress/stressOperatorToolSchemas';
import type { TComputerToolsetMember } from '@scripts/stress/stressOperatorToolSchemas';
import type { IStressOperatorReport } from '@scripts/stress/stressTypes';

export interface IStressScreenshot {
    png: Uint8Array;
    sha256: string;
    width: number;
    height: number;
}

export interface IStressToolExecution {
    content: string | Array<TextBlockParam | ImageBlockParam>;
    isError: boolean;
    /** True for actions that should move the UI; feeds the freeze detector. */
    stateChanging: boolean;
    screenshot: IStressScreenshot | null;
    report: IStressOperatorReport | null;
}

export interface IStressOperatorToolContext {
    session: IElectronE2ESession;
    /** Real paths the operator may open; anything else is refused before touching the app. */
    allowedPaths: Map<string, {kind: 'pdf' | 'djvu'}>;
    viewport: {
        width: number;
        height: number;
    };
    stepTimeoutMs: number;
    log: (line: string) => void;
}

export interface IStressToolCall {
    toolsetName: string | null;
    name: string;
    input: unknown;
}

const MAX_WAIT_SECONDS = 10;
const MAX_HOLD_SECONDS = 5;
const WHEEL_PIXELS_PER_NOTCH = 100;
const CONTROLS_KEY = '__evbStressControls';

interface IStressControlsWindow extends Window {__evbStressControls?: Map<string, Element>;}
const PROTECTED_DIALOG_SELECTOR = '[role="alertdialog"]';

const KEY_ALIASES: Record<string, KeyInput> = {
    return: 'Enter',
    enter: 'Enter',
    kp_enter: 'Enter',
    escape: 'Escape',
    esc: 'Escape',
    tab: 'Tab',
    space: 'Space',
    backspace: 'Backspace',
    delete: 'Delete',
    home: 'Home',
    end: 'End',
    page_down: 'PageDown',
    pagedown: 'PageDown',
    next: 'PageDown',
    page_up: 'PageUp',
    pageup: 'PageUp',
    prior: 'PageUp',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    arrowup: 'ArrowUp',
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    ctrl: 'Control',
    control: 'Control',
    alt: 'Alt',
    option: 'Alt',
    shift: 'Shift',
    super: 'Meta',
    cmd: 'Meta',
    command: 'Meta',
    meta: 'Meta',
    win: 'Meta',
    plus: '+',
    minus: '-',
    equal: '=',
};

const MODIFIER_KEYS = new Set<KeyInput>([
    'Control',
    'Alt',
    'Shift',
    'Meta',
]);

/** xdotool-style names ("ctrl+f", "Page_Down") to puppeteer `KeyInput`; exported for unit tests. */
export function mapXdotoolKey(raw: string): KeyInput {
    const trimmed = raw.trim();
    const alias = KEY_ALIASES[trimmed.toLowerCase()];
    if (alias) {
        return alias;
    }
    if (/^f\d{1,2}$/iu.test(trimmed)) {
        return `F${trimmed.slice(1)}` as KeyInput;
    }
    if (trimmed.length === 1) {
        return trimmed as KeyInput;
    }
    return trimmed as KeyInput;
}

export function parseKeyChord(raw: string) {
    const parts = raw.split('+').map(part => part.trim()).filter(part => part.length > 0);
    if (raw.trim() === '+') {
        parts.splice(0, parts.length, '+');
    }
    const keys = parts.map(mapXdotoolKey);
    const modifiers = keys.filter(key => MODIFIER_KEYS.has(key));
    const main = keys.filter(key => !MODIFIER_KEYS.has(key));
    return {
        modifiers,
        main,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCoordinate(input: Record<string, unknown>, key: string, viewport: {
    width: number;
    height: number
}) {
    const value = input[key];
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'number' || typeof value[1] !== 'number') {
        throw new Error(`${key} must be [x, y]`);
    }
    const x = Math.round(value[0]);
    const y = Math.round(value[1]);
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
        throw new Error(`${key} [${x}, ${y}] is outside the ${viewport.width}x${viewport.height} screen`);
    }
    return {
        x,
        y,
    };
}

function readString(input: Record<string, unknown>, key: string, fallback: string | null = null) {
    const value = input[key];
    if (typeof value === 'string') {
        return value;
    }
    if (fallback !== null) {
        return fallback;
    }
    throw new Error(`${key} must be a string`);
}

function readNumber(input: Record<string, unknown>, key: string, fallback: number) {
    const value = input[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function sha256(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export interface IStressZoomRegion {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Pure: a model may ask for a region outside the 1280x800 screenshot, which
 * CDP rejects. Clamping keeps at least one pixel inside the viewport.
 */
export function clampZoomRegion(region: readonly number[], viewport: {
    width: number;
    height: number
}): IStressZoomRegion {
    const [
        x0 = 0,
        y0 = 0,
        x1 = 0,
        y1 = 0,
    ] = region;
    const left = Math.min(Math.max(0, Math.min(x0, x1)), viewport.width - 1);
    const top = Math.min(Math.max(0, Math.min(y0, y1)), viewport.height - 1);
    const right = Math.min(Math.max(left + 1, Math.max(x0, x1)), viewport.width);
    const bottom = Math.min(Math.max(top + 1, Math.max(y0, y1)), viewport.height);
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
}

export async function captureStressScreenshot(page: Page, viewport: {
    width: number;
    height: number
}, clip?: {
    x: number;
    y: number;
    width: number;
    height: number
}): Promise<IStressScreenshot> {
    const png = await page.screenshot({
        type: 'png',
        encoding: 'binary',
        captureBeyondViewport: false,
        ...(clip ? {clip} : {}),
    });
    return {
        png,
        sha256: sha256(png),
        width: clip?.width ?? viewport.width,
        height: clip?.height ?? viewport.height,
    };
}

function imageBlock(screenshot: IStressScreenshot): ImageBlockParam {
    return {
        type: 'image',
        source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from(screenshot.png).toString('base64'),
        },
    };
}

function ok(content = 'OK', stateChanging = true): IStressToolExecution {
    return {
        content,
        isError: false,
        stateChanging,
        screenshot: null,
        report: null,
    };
}

function withScreenshot(screenshot: IStressScreenshot, text: string | null, stateChanging: boolean): IStressToolExecution {
    const content: Array<TextBlockParam | ImageBlockParam> = [];
    if (text) {
        content.push({
            type: 'text',
            text,
        });
    }
    content.push(imageBlock(screenshot));
    return {
        content,
        isError: false,
        stateChanging,
        screenshot,
        report: null,
    };
}

async function pressChord(page: Page, chord: string, repeat: number) {
    const {
        modifiers,
        main,
    } = parseKeyChord(chord);
    if (main.length === 0 && modifiers.length === 0) {
        throw new Error(`unrecognised key "${chord}"`);
    }
    for (let iteration = 0; iteration < repeat; iteration += 1) {
        for (const modifier of modifiers) {
            await page.keyboard.down(modifier);
        }
        try {
            for (const key of main) {
                await page.keyboard.press(key);
            }
        } finally {
            for (const modifier of [...modifiers].reverse()) {
                await page.keyboard.up(modifier);
            }
        }
    }
}

async function isPointInsideProtectedDialog(page: Page, x: number, y: number) {
    return evaluateInPage(page, (px: number, py: number, selector: string) => {
        const target = document.elementFromPoint(px, py);
        return Boolean(target?.closest(selector));
    }, x, y, PROTECTED_DIALOG_SELECTOR);
}

async function clickAt(context: IStressOperatorToolContext, x: number, y: number, button: 'left' | 'right' | 'middle', clickCount: number, modifierText: string | null) {
    if (await isPointInsideProtectedDialog(context.session.page, x, y)) {
        throw new Error('That point is inside an error dialog. Do not dismiss it; describe it in your report and continue.');
    }
    const modifiers = modifierText ? parseKeyChord(modifierText).modifiers : [];
    const {page} = context.session;
    for (const modifier of modifiers) {
        await page.keyboard.down(modifier);
    }
    try {
        await page.mouse.click(x, y, {
            button,
            count: clickCount,
        });
    } finally {
        for (const modifier of [...modifiers].reverse()) {
            await page.keyboard.up(modifier);
        }
    }
}

async function dragBetween(page: Page, from: {
    x: number;
    y: number
}, to: {
    x: number;
    y: number
}, steps: number) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, {steps});
    await page.mouse.up();
}

const cursorByPage = new WeakMap<Page, {
    x: number;
    y: number
}>();

function rememberCursor(page: Page, x: number, y: number) {
    cursorByPage.set(page, {
        x,
        y,
    });
}

async function executeComputerAction(context: IStressOperatorToolContext, name: TComputerToolsetMember, input: Record<string, unknown>): Promise<IStressToolExecution> {
    const {page} = context.session;
    const {viewport} = context;
    switch (name) {
        case 'screenshot':
            return withScreenshot(await captureStressScreenshot(page, viewport), null, false);
        case 'zoom': {
            const region = input.region;
            if (!Array.isArray(region) || region.length !== 4 || region.some(value => typeof value !== 'number')) {
                throw new Error('region must be [x0, y0, x1, y1]');
            }
            const clip = clampZoomRegion(region as number[], viewport);
            return withScreenshot(await captureStressScreenshot(page, viewport, clip), `zoomed region ${JSON.stringify(region)}`, false);
        }
        case 'left_click':
        case 'right_click':
        case 'middle_click':
        case 'double_click':
        case 'triple_click': {
            const {
                x,
                y,
            } = readCoordinate(input, 'coordinate', viewport);
            const button = name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left';
            const clickCount = name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1;
            await clickAt(context, x, y, button, clickCount, readString(input, 'text', ''));
            rememberCursor(page, x, y);
            return ok();
        }
        case 'left_click_drag': {
            const from = readCoordinate(input, 'start_coordinate', viewport);
            const to = readCoordinate(input, 'coordinate', viewport);
            await dragBetween(page, from, to, 12);
            rememberCursor(page, to.x, to.y);
            return ok();
        }
        case 'mouse_move': {
            const {
                x,
                y,
            } = readCoordinate(input, 'coordinate', viewport);
            await page.mouse.move(x, y);
            rememberCursor(page, x, y);
            return ok('OK', false);
        }
        case 'left_mouse_down': {
            if (Array.isArray(input.coordinate)) {
                const {
                    x,
                    y,
                } = readCoordinate(input, 'coordinate', viewport);
                await page.mouse.move(x, y);
                rememberCursor(page, x, y);
            }
            await page.mouse.down();
            return ok();
        }
        case 'left_mouse_up': {
            if (Array.isArray(input.coordinate)) {
                const {
                    x,
                    y,
                } = readCoordinate(input, 'coordinate', viewport);
                await page.mouse.move(x, y);
                rememberCursor(page, x, y);
            }
            await page.mouse.up();
            return ok();
        }
        case 'cursor_position': {
            const cursor = cursorByPage.get(page) ?? {
                x: 0,
                y: 0,
            };
            return ok(`X=${cursor.x},Y=${cursor.y}`, false);
        }
        case 'scroll': {
            const direction = readString(input, 'scroll_direction');
            const amount = Math.max(1, Math.min(200, Math.round(readNumber(input, 'scroll_amount', 3))));
            if (Array.isArray(input.coordinate)) {
                const {
                    x,
                    y,
                } = readCoordinate(input, 'coordinate', viewport);
                await page.mouse.move(x, y);
                rememberCursor(page, x, y);
            }
            const distance = amount * WHEEL_PIXELS_PER_NOTCH;
            const delta = direction === 'up' ? {deltaY: -distance}
                : direction === 'down' ? {deltaY: distance}
                    : direction === 'left' ? {deltaX: -distance}
                        : direction === 'right' ? {deltaX: distance}
                            : null;
            if (!delta) {
                throw new Error('scroll_direction must be up, down, left or right');
            }
            await page.mouse.wheel(delta);
            return ok();
        }
        case 'type': {
            await page.keyboard.type(readString(input, 'text'), {delay: 8});
            return ok();
        }
        case 'key': {
            const repeat = Math.max(1, Math.min(50, Math.round(readNumber(input, 'repeat', 1))));
            await pressChord(page, readString(input, 'text'), repeat);
            return ok();
        }
        case 'hold_key': {
            const seconds = Math.max(0.1, Math.min(MAX_HOLD_SECONDS, readNumber(input, 'duration', 1)));
            const {
                modifiers,
                main,
            } = parseKeyChord(readString(input, 'text'));
            const keys = [
                ...modifiers,
                ...main,
            ];
            for (const key of keys) {
                await page.keyboard.down(key);
            }
            try {
                await delay(seconds * 1000);
            } finally {
                for (const key of [...keys].reverse()) {
                    await page.keyboard.up(key);
                }
            }
            return ok();
        }
        case 'wait': {
            const seconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, readNumber(input, 'duration', 1)));
            await delay(seconds * 1000);
            return withScreenshot(await captureStressScreenshot(page, viewport), `waited ${seconds}s`, false);
        }
    }
}

interface IObservedControl {
    id: string;
    role: string;
    label: string;
    x: number;
    y: number;
    disabled: boolean;
}

async function observeControls(page: Page) {
    return evaluateInPage(page, (controlsKey: string): IObservedControl[] => {
        const selector = 'button, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], input, textarea, select, a[href], [contenteditable="true"]';
        const isVisible = (element: Element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
        };
        const labelOf = (element: Element) => {
            const explicit = element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.getAttribute('placeholder');
            const text = (explicit ?? element.textContent).replace(/\s+/gu, ' ').trim();
            return text.slice(0, 60);
        };
        const registry = new Map<string, Element>();
        const controls: IObservedControl[] = [];
        let index = 0;
        for (const element of Array.from(document.querySelectorAll(selector))) {
            if (!isVisible(element)) {
                continue;
            }
            index += 1;
            const id = `c${index}`;
            const rect = element.getBoundingClientRect();
            registry.set(id, element);
            controls.push({
                id,
                role: element.getAttribute('role') ?? element.tagName.toLowerCase(),
                label: labelOf(element),
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                disabled: element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.disabled : element.getAttribute('aria-disabled') === 'true',
            });
        }
        (window as IStressControlsWindow)[controlsKey as typeof CONTROLS_KEY] = registry;
        return controls;
    }, CONTROLS_KEY);
}

async function resolveControlCenter(page: Page, id: string) {
    const center = await evaluateInPage(page, (controlsKey: string, controlId: string) => {
        const registry = (window as IStressControlsWindow)[controlsKey as typeof CONTROLS_KEY];
        if (!registry) {
            return null;
        }
        const element = registry.get(controlId);
        if (!(element instanceof Element) || !element.isConnected) {
            return null;
        }
        const rect = element.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    }, CONTROLS_KEY, id);
    if (!center) {
        throw new Error(`control ${id} is stale; call observe again`);
    }
    return center;
}

function formatControls(controls: IObservedControl[]) {
    if (controls.length === 0) {
        return 'controls: none visible';
    }
    return [
        'controls:',
        ...controls.map(control => `  ${control.id} ${control.role} "${control.label || '(unlabelled)'}"${control.disabled ? ' [disabled]' : ''}`),
    ].join('\n');
}

async function executeSemanticTool(context: IStressOperatorToolContext, name: string, input: Record<string, unknown>): Promise<IStressToolExecution | null> {
    const {page} = context.session;
    switch (name) {
        case 'observe': {
            const [
                controls,
                state,
            ] = await Promise.all([
                observeControls(page),
                collectStressAppState(page),
            ]);
            const text = `${formatStressAppStateForModel(state)}\n${formatControls(controls)}`;
            if (input.with_image === true) {
                return withScreenshot(await captureStressScreenshot(page, context.viewport), text, false);
            }
            return ok(text, false);
        }
        case 'click': {
            const center = await resolveControlCenter(page, readString(input, 'id'));
            const button = readString(input, 'button', 'left') === 'right' ? 'right' : 'left';
            const count = readNumber(input, 'count', 1) === 2 ? 2 : 1;
            await clickAt(context, center.x, center.y, button, count, null);
            rememberCursor(page, center.x, center.y);
            return ok();
        }
        case 'type_text': {
            if (input.clear_first === true) {
                await pressChord(page, process.platform === 'darwin' ? 'cmd+a' : 'ctrl+a', 1);
                await page.keyboard.press('Backspace');
            }
            await page.keyboard.type(readString(input, 'text'), {delay: 8});
            return ok();
        }
        case 'press_key': {
            const repeat = Math.max(1, Math.min(50, Math.round(readNumber(input, 'repeat', 1))));
            await pressChord(page, readString(input, 'key'), repeat);
            return ok();
        }
        case 'scroll': {
            const direction = readString(input, 'direction');
            const amount = Math.max(1, Math.min(200, Math.round(readNumber(input, 'amount', 5))));
            const repeat = Math.max(1, Math.min(20, Math.round(readNumber(input, 'repeat', 1))));
            const viewportCenter = await evaluateInPage(page, () => {
                const viewport = document.querySelector('.editor-pane.is-active [data-document-viewer-chassis-viewport], [data-document-viewer-chassis-viewport], #pdf-viewer');
                if (!viewport) {
                    return null;
                }
                const rect = viewport.getBoundingClientRect();
                return {
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                };
            });
            if (!viewportCenter) {
                throw new Error('no document viewport is visible');
            }
            await page.mouse.move(viewportCenter.x, viewportCenter.y);
            for (let iteration = 0; iteration < repeat; iteration += 1) {
                await page.mouse.wheel({deltaY: (direction === 'up' ? -1 : 1) * amount * WHEEL_PIXELS_PER_NOTCH});
                await delay(60);
            }
            return ok();
        }
        case 'drag': {
            const from = await resolveControlCenter(page, readString(input, 'from_id'));
            const steps = Math.max(1, Math.min(60, Math.round(readNumber(input, 'steps', 10))));
            let to: {
                x: number;
                y: number
            };
            if (typeof input.to_id === 'string') {
                to = await resolveControlCenter(page, input.to_id);
            } else if (isRecord(input.to_offset)) {
                to = {
                    x: from.x + readNumber(input.to_offset, 'dx', 0),
                    y: from.y + readNumber(input.to_offset, 'dy', 0),
                };
            } else {
                throw new Error('drag needs to_id or to_offset');
            }
            await dragBetween(page, from, to, steps);
            return ok();
        }
        default:
            return null;
    }
}

async function waitForOpenOutcome(page: Page, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await getWorkspaceToolbarSnapshot(page).catch(() => null);
        if (snapshot?.hasOpenError) {
            return 'open-error' as const;
        }
        if (snapshot?.hasPdf && !snapshot.isOpeningDocument) {
            return 'loaded' as const;
        }
        await delay(250);
    }
    return 'timeout' as const;
}

function parseReport(input: Record<string, unknown>): IStressOperatorReport {
    const outcome = input.outcome;
    if (outcome !== 'completed' && outcome !== 'blocked' && outcome !== 'app_broken') {
        throw new Error('outcome must be completed, blocked or app_broken');
    }
    const stepsDone = Array.isArray(input.steps_done) ? input.steps_done.filter((step): step is string => typeof step === 'string') : [];
    return {
        outcome,
        stepsDone,
        problem: typeof input.problem === 'string' && input.problem.length > 0 ? input.problem : null,
        slowestAction: typeof input.slowest_action === 'string' && input.slowest_action.length > 0 ? input.slowest_action : null,
        finalPage: typeof input.final_page === 'number' ? input.final_page : null,
    };
}

async function executeSharedTool(context: IStressOperatorToolContext, name: string, input: Record<string, unknown>): Promise<IStressToolExecution | null> {
    const {page} = context.session;
    switch (name) {
        case 'open_document': {
            const requested = readString(input, 'path');
            let resolved: string;
            try {
                resolved = await realpath(requested);
            } catch {
                throw new Error(`path is not readable: ${requested}`);
            }
            const allowed = context.allowedPaths.get(resolved);
            if (!allowed) {
                throw new Error('That path is not in the task card. Only listed files may be opened.');
            }
            if (input.in_new_tab === true) {
                await createNewWorkspaceTab(context.session);
            }
            try {
                if (allowed.kind === 'djvu') {
                    await openDjvuInApp(page, resolved, context.stepTimeoutMs);
                } else {
                    await openPdfInApp(page, resolved, context.stepTimeoutMs);
                }
            } catch (error) {
                const outcome = await waitForOpenOutcome(page, 2_000);
                if (outcome === 'open-error') {
                    return ok('The viewer shows an open error for this file. Do not dismiss it; describe it in your report.');
                }
                throw error;
            }
            const state = await collectStressAppState(page);
            return ok(`opened\n${formatStressAppStateForModel(state)}`);
        }
        case 'wait_for_idle': {
            const timeoutMs = Math.max(1_000, Math.min(120_000, Math.round(readNumber(input, 'timeout_ms', 30_000))));
            const startedAt = Date.now();
            let timedOut = false;
            try {
                await waitForWorkspaceToolbarIdle(page, {timeoutMs});
            } catch {
                timedOut = true;
            }
            const state = await collectStressAppState(page);
            const prefix = timedOut ? `still busy after ${Date.now() - startedAt}ms` : `idle after ${Date.now() - startedAt}ms`;
            return ok(`${prefix}\n${formatStressAppStateForModel(state)}`, false);
        }
        case 'app_state': {
            const state = await collectStressAppState(page);
            return ok(formatStressAppStateForModel(state), false);
        }
        case 'report': {
            const report = parseReport(input);
            return {
                content: 'Report recorded. The task is over.',
                isError: false,
                stateChanging: false,
                screenshot: null,
                report,
            };
        }
        default:
            return null;
    }
}

function failure(message: string): IStressToolExecution {
    return {
        content: message,
        isError: true,
        stateChanging: false,
        screenshot: null,
        report: null,
    };
}

/**
 * Single dispatch point for every tool the operator can call. `open_document`
 * goes through the same load-wait helpers the deterministic driver uses, so
 * the operator cannot open a file the sandbox did not list.
 */
export async function executeStressOperatorTool(context: IStressOperatorToolContext, call: IStressToolCall): Promise<IStressToolExecution> {
    const input = isRecord(call.input) ? call.input : {};
    try {
        if (call.toolsetName === COMPUTER_TOOLSET_NAME) {
            if (!isComputerToolsetMember(call.name)) {
                return failure(`unknown computer action ${call.name}`);
            }
            return await executeComputerAction(context, call.name, input);
        }
        const shared = await executeSharedTool(context, call.name, input);
        if (shared) {
            return shared;
        }
        const semantic = await executeSemanticTool(context, call.name, input);
        if (semantic) {
            return semantic;
        }
        return failure(`unknown tool ${call.name}`);
    } catch (error) {
        const message = getErrorMessage(error);
        context.log(`tool ${call.name} failed: ${message}`);
        return failure(message);
    }
}
