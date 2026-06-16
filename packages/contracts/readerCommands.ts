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
export type TReaderCommandIconName = `ph:${string}`;

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
    icon: TReaderCommandIconName;
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
        icon: 'ph:caret-down',
        requiresDocument: false,
    },
    'capture-region': {
        id: 'capture-region',
        category: 'export',
        labelKey: 'toolbar.captureRegion',
        icon: 'ph:scan',
        requiresDocument: true,
    },
    'continuous-scroll': {
        id: 'continuous-scroll',
        category: 'view',
        labelKey: 'zoom.continuousScroll',
        icon: 'ph:scroll',
        requiresDocument: true,
    },
    crop: {
        id: 'crop',
        category: 'export',
        labelKey: 'toolbar.crop',
        icon: 'ph:crop',
        requiresDocument: true,
    },
    'drag-mode': {
        id: 'drag-mode',
        category: 'view',
        labelKey: 'zoom.handTool',
        icon: 'ph:hand',
        requiresDocument: true,
    },
    'export-docx': {
        id: 'export-docx',
        category: 'export',
        labelKey: 'toolbar.exportDocx',
        icon: 'ph:file-text',
        requiresDocument: true,
    },
    'actual-size': {
        id: 'actual-size',
        category: 'view',
        labelKey: 'zoom.actualSize',
        icon: 'ph:magnifying-glass',
        requiresDocument: true,
    },
    'fit-height': {
        id: 'fit-height',
        category: 'view',
        labelKey: 'zoom.fitHeight',
        icon: 'ph:arrows-out-line-vertical',
        requiresDocument: true,
    },
    'fit-width': {
        id: 'fit-width',
        category: 'view',
        labelKey: 'zoom.fitWidth',
        icon: 'ph:arrows-out-line-horizontal',
        requiresDocument: true,
    },
    fullscreen: {
        id: 'fullscreen',
        category: 'shell',
        labelKey: 'toolbar.fullscreen',
        icon: 'ph:corners-out',
        requiresDocument: false,
    },
    ocr: {
        id: 'ocr',
        category: 'export',
        labelKey: 'ocr.button',
        icon: 'ph:text-aa',
        requiresDocument: true,
    },
    'open-file': {
        id: 'open-file',
        category: 'document',
        labelKey: 'toolbar.openPdf',
        icon: 'ph:folder-open',
        requiresDocument: false,
    },
    'overflow-menu': {
        id: 'overflow-menu',
        category: 'shell',
        labelKey: 'toolbar.moreTools',
        icon: 'ph:dots-three',
        requiresDocument: false,
    },
    'page-navigation': {
        id: 'page-navigation',
        category: 'navigation',
        labelKey: 'annotations.page',
        icon: 'ph:caret-right',
        requiresDocument: true,
    },
    print: {
        id: 'print',
        category: 'export',
        labelKey: 'toolbar.print',
        icon: 'ph:printer',
        requiresDocument: true,
    },
    'print-current-page': {
        id: 'print-current-page',
        category: 'export',
        labelKey: 'toolbar.printCurrentPage',
        icon: 'ph:printer',
        requiresDocument: true,
    },
    'quick-note': {
        id: 'quick-note',
        category: 'annotation',
        labelKey: 'annotations.createNotes',
        icon: 'ph:chat-circle-dots',
        requiresDocument: true,
    },
    redo: {
        id: 'redo',
        category: 'history',
        labelKey: 'toolbar.redo',
        icon: 'ph:arrow-u-up-right',
        requiresDocument: true,
    },
    save: {
        id: 'save',
        category: 'document',
        labelKey: 'toolbar.save',
        icon: 'ph:floppy-disk',
        requiresDocument: true,
    },
    'save-as': {
        id: 'save-as',
        category: 'document',
        labelKey: 'toolbar.saveAs',
        icon: 'ph:floppy-disk-back',
        requiresDocument: true,
    },
    settings: {
        id: 'settings',
        category: 'shell',
        labelKey: 'toolbar.settings',
        icon: 'ph:gear',
        requiresDocument: false,
    },
    'text-select': {
        id: 'text-select',
        category: 'view',
        labelKey: 'zoom.textSelect',
        icon: 'ph:cursor-text',
        requiresDocument: true,
    },
    'toggle-sidebar': {
        id: 'toggle-sidebar',
        category: 'navigation',
        labelKey: 'toolbar.toggleSidebar',
        icon: 'ph:sidebar-simple',
        requiresDocument: true,
    },
    undo: {
        id: 'undo',
        category: 'history',
        labelKey: 'toolbar.undo',
        icon: 'ph:arrow-u-up-left',
        requiresDocument: true,
    },
    'view-mode': {
        id: 'view-mode',
        category: 'view',
        labelKey: 'zoom.sectionLayout',
        icon: 'ph:book-open',
        requiresDocument: true,
    },
    zoom: {
        id: 'zoom',
        category: 'view',
        labelKey: 'zoom.zoomIn',
        icon: 'ph:magnifying-glass-plus',
        requiresDocument: true,
    },
} satisfies Readonly<Record<TReaderCommandId, IReaderCommandDescriptor>>);
