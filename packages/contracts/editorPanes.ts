export type TPaneDirection = 'left' | 'right' | 'up' | 'down';

export type TPaneOrientation = 'horizontal' | 'vertical';

export interface IEditorPaneState {
    id: string;
    tabIds: string[];
    activeTabId: string | null;
}

export interface IEditorLayoutLeafNode {
    type: 'leaf';
    paneId: string;
}

export interface IEditorLayoutSplitNode {
    type: 'split';
    id: string;
    orientation: TPaneOrientation;
    ratio: number;
    first: TEditorLayoutNode;
    second: TEditorLayoutNode;
}

export type TEditorLayoutNode = IEditorLayoutLeafNode | IEditorLayoutSplitNode;

export interface IEditorPaneRect {
    paneId: string;
    x: number;
    y: number;
    width: number;
    height: number;
}
