type TModifier = 'mod' | 'shift';

interface IShortcutDef {
    key: string;
    modifiers: TModifier[];
    nonMacOverride?: {
        key: string;
        modifiers: TModifier[] 
    };
}

export const SHORTCUTS = {
    openFile: {
        key: 'O',
        modifiers: ['mod'], 
    },
    save: {
        key: 'S',
        modifiers: ['mod'], 
    },
    saveAs: {
        key: 'S',
        modifiers: [
            'mod',
            'shift',
        ], 
    },
    toggleSidebar: {
        key: 'B',
        modifiers: ['mod'], 
    },
    search: {
        key: 'F',
        modifiers: ['mod'], 
    },
    undo: {
        key: 'Z',
        modifiers: ['mod'], 
    },
    redo: {
        key: 'Z',
        modifiers: [
            'mod',
            'shift',
        ],
        nonMacOverride: {
            key: 'Y',
            modifiers: ['mod'], 
        }, 
    },
    exportDocx: {
        key: 'E',
        modifiers: [
            'mod',
            'shift',
        ], 
    },
    fitWidth: {
        key: '1',
        modifiers: ['mod'], 
    },
    fitHeight: {
        key: '2',
        modifiers: ['mod'], 
    },
    zoomIn: {
        key: '=',
        modifiers: ['mod'], 
    },
    zoomOut: {
        key: '\u2212',
        modifiers: ['mod'], 
    },
    actualSize: {
        key: '0',
        modifiers: ['mod'], 
    },
} as const satisfies Record<string, IShortcutDef>;

export type TShortcutName = keyof typeof SHORTCUTS;

function isMacPlatform() {
    return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
}

function resolveModifierLabel(m: TModifier, isMac: boolean): string {
    if (m === 'mod') {
        return isMac ? 'Cmd' : 'Ctrl';
    }
    return 'Shift';
}

function formatShortcutLabel(def: IShortcutDef, isMac: boolean) {
    const activeDef = (!isMac && def.nonMacOverride) ? def.nonMacOverride : def;
    const parts = activeDef.modifiers.map(m => resolveModifierLabel(m, isMac));
    parts.push(activeDef.key);
    return parts.join('+');
}

export function getShortcutLabels() {
    const isMac = isMacPlatform();
    return Object.fromEntries(
        Object.entries(SHORTCUTS).map(([
            name,
            def,
        ]) => [
            name,
            formatShortcutLabel(def, isMac),
        ]),
    ) as Record<TShortcutName, string>;
}
