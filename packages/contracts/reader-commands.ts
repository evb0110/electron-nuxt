export const READER_COMMAND_CATEGORIES = [
    'document',
    'view',
    'navigation',
    'annotation',
    'export',
    'history',
    'shell',
] as const;

export type TReaderCommandCategory = typeof READER_COMMAND_CATEGORIES[number];

export const READER_COMMANDS = [
    'app-menu',
    'capture-region',
    'continuous-scroll',
    'crop',
    'drag-mode',
    'export-docx',
    'actual-size',
    'fit-height',
    'fit-width',
    'fullscreen',
    'ocr',
    'open-file',
    'overflow-menu',
    'page-navigation',
    'print',
    'print-current-page',
    'quick-note',
    'redo',
    'save',
    'save-as',
    'settings',
    'text-select',
    'toggle-sidebar',
    'undo',
    'view-mode',
    'zoom',
] as const;

export type TReaderCommandId = typeof READER_COMMANDS[number];
export type TReaderCommandPlacement = 'inline' | 'menu';
export type TReaderCommandMap = Readonly<Record<TReaderCommandId, boolean>>;

export interface IReaderCommandDescriptor {
    id: TReaderCommandId;
    category: TReaderCommandCategory;
    labelKey: string;
    icon: string;
    requiresDocument: boolean;
}

export interface IReaderCommandSurface {
    inline: TReaderCommandMap;
    menu: TReaderCommandMap;
}

export interface IReaderCommandState {
    id: TReaderCommandId;
    enabled: boolean;
    visible: boolean;
    selected?: boolean;
}

export interface IReaderCommandStateSnapshot { commands: readonly IReaderCommandState[] }

export interface IReaderCommandRequest {
    id: TReaderCommandId;
    payload?: unknown;
}

export const READER_COMMAND_DESCRIPTORS = Object.freeze({
    'app-menu': {
        id: 'app-menu',
        category: 'shell',
        labelKey: 'toolbar.appMenu',
        icon: 'menu',
        requiresDocument: false,
    },
    'capture-region': {
        id: 'capture-region',
        category: 'export',
        labelKey: 'toolbar.captureRegion',
        icon: 'scan',
        requiresDocument: true,
    },
    'continuous-scroll': {
        id: 'continuous-scroll',
        category: 'view',
        labelKey: 'zoom.continuousScroll',
        icon: 'scroll',
        requiresDocument: true,
    },
    crop: {
        id: 'crop',
        category: 'export',
        labelKey: 'toolbar.crop',
        icon: 'crop',
        requiresDocument: true,
    },
    'drag-mode': {
        id: 'drag-mode',
        category: 'view',
        labelKey: 'zoom.handTool',
        icon: 'hand',
        requiresDocument: true,
    },
    'export-docx': {
        id: 'export-docx',
        category: 'export',
        labelKey: 'toolbar.exportDocx',
        icon: 'file-text',
        requiresDocument: true,
    },
    'actual-size': {
        id: 'actual-size',
        category: 'view',
        labelKey: 'zoom.actualSize',
        icon: 'magnifying-glass',
        requiresDocument: true,
    },
    'fit-height': {
        id: 'fit-height',
        category: 'view',
        labelKey: 'zoom.fitHeight',
        icon: 'move-vertical',
        requiresDocument: true,
    },
    'fit-width': {
        id: 'fit-width',
        category: 'view',
        labelKey: 'zoom.fitWidth',
        icon: 'move-horizontal',
        requiresDocument: true,
    },
    fullscreen: {
        id: 'fullscreen',
        category: 'shell',
        labelKey: 'toolbar.fullscreen',
        icon: 'expand',
        requiresDocument: false,
    },
    ocr: {
        id: 'ocr',
        category: 'export',
        labelKey: 'ocr.button',
        icon: 'scan-text',
        requiresDocument: true,
    },
    'open-file': {
        id: 'open-file',
        category: 'document',
        labelKey: 'toolbar.openPdf',
        icon: 'folder-open',
        requiresDocument: false,
    },
    'overflow-menu': {
        id: 'overflow-menu',
        category: 'shell',
        labelKey: 'toolbar.moreTools',
        icon: 'ellipsis',
        requiresDocument: false,
    },
    'page-navigation': {
        id: 'page-navigation',
        category: 'navigation',
        labelKey: 'annotations.page',
        icon: 'chevron-right',
        requiresDocument: true,
    },
    print: {
        id: 'print',
        category: 'export',
        labelKey: 'toolbar.print',
        icon: 'printer',
        requiresDocument: true,
    },
    'print-current-page': {
        id: 'print-current-page',
        category: 'export',
        labelKey: 'toolbar.printCurrentPage',
        icon: 'printer',
        requiresDocument: true,
    },
    'quick-note': {
        id: 'quick-note',
        category: 'annotation',
        labelKey: 'annotations.createNotes',
        icon: 'message-square-plus',
        requiresDocument: true,
    },
    redo: {
        id: 'redo',
        category: 'history',
        labelKey: 'toolbar.redo',
        icon: 'redo-2',
        requiresDocument: true,
    },
    save: {
        id: 'save',
        category: 'document',
        labelKey: 'toolbar.save',
        icon: 'save',
        requiresDocument: true,
    },
    'save-as': {
        id: 'save-as',
        category: 'document',
        labelKey: 'toolbar.saveAs',
        icon: 'save-all',
        requiresDocument: true,
    },
    settings: {
        id: 'settings',
        category: 'shell',
        labelKey: 'toolbar.settings',
        icon: 'settings',
        requiresDocument: false,
    },
    'text-select': {
        id: 'text-select',
        category: 'view',
        labelKey: 'zoom.textSelect',
        icon: 'text-cursor',
        requiresDocument: true,
    },
    'toggle-sidebar': {
        id: 'toggle-sidebar',
        category: 'navigation',
        labelKey: 'toolbar.toggleSidebar',
        icon: 'panel-left',
        requiresDocument: true,
    },
    undo: {
        id: 'undo',
        category: 'history',
        labelKey: 'toolbar.undo',
        icon: 'undo-2',
        requiresDocument: true,
    },
    'view-mode': {
        id: 'view-mode',
        category: 'view',
        labelKey: 'zoom.sectionLayout',
        icon: 'book-open',
        requiresDocument: true,
    },
    zoom: {
        id: 'zoom',
        category: 'view',
        labelKey: 'zoom.zoomIn',
        icon: 'zoom-in',
        requiresDocument: true,
    },
} satisfies Readonly<Record<TReaderCommandId, IReaderCommandDescriptor>>);
