import type {
    IAgentCapabilityDescriptor,
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    TAgentCommand,
    TAgentCapabilityDomain,
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import type {
    IAgentDocumentPageReadOptions,
    IAgentDocumentSearchOptions,
    IAgentDocumentTextOperationInput,
} from '@electron/features/agent/documentText';
import { getErrorMessage } from '@electron/utils/error';
import {
    createErrorResponse,
    createResultResponse,
    getJsonRpcId,
    type IJsonRpcResponse,
} from '@electron/features/agent/mcp/mcpJsonRpc';
import {
    AGENT_CAPABILITY_TEMPLATES,
    MCP_PROMPTS,
    MCP_RESOURCE_TEMPLATES,
    MCP_TOOLS,
    type IAgentCapabilityTemplate,
    type IMcpResourceDefinition,
} from '@electron/features/agent/mcp/mcpDefinitions';

const MCP_PROTOCOL_VERSION = '2025-11-25';
const MAX_READ_DOCUMENT_PAGES_PER_REQUEST = 50;

interface IJsonRpcRequest {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
}


interface IMcpToolTextContent {
    type: 'text';
    text: string;
}

interface IMcpToolImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}

type TMcpToolContent = IMcpToolTextContent | IMcpToolImageContent;


export interface ILocalMcpServerIdentity {
    name: string;
    title: string;
    appName: string;
    version: string;
    isPackaged: boolean;
    userDataPath: string | null;
    host: string;
    port: number;
}

export interface ILocalMcpServerDescriptor {
    name: string;
    title: string;
    host: string;
    port: number;
    url: string;
}

export type TMcpCallerKind = 'internal' | 'external';

export interface IProcessMcpRequestOptions {
    identity: ILocalMcpServerIdentity;
    callerKind?: TMcpCallerKind;
    getWorkspaceSnapshot(windowId?: number): Promise<IAgentWorkspaceSnapshot>;
    runCommand(command: TAgentCommand, windowId?: number): Promise<Record<string, unknown>>;
    inspectDocumentText?(
        input: IAgentDocumentTextOperationInput<Record<never, never>>,
        windowId?: number,
    ): Promise<Record<string, unknown>>;
    searchDocument?(
        input: IAgentDocumentTextOperationInput<IAgentDocumentSearchOptions>,
        windowId?: number,
    ): Promise<Record<string, unknown>>;
    readDocumentPages?(
        input: IAgentDocumentTextOperationInput<IAgentDocumentPageReadOptions>,
        windowId?: number,
    ): Promise<Record<string, unknown>>;
}


function getMcpImagePayload(data: unknown) {
    if (!isRecord(data) || !isRecord(data.image)) {
        return null;
    }

    const { image } = data;
    return typeof image.data === 'string'
        && image.data.trim().length > 0
        && typeof image.mimeType === 'string'
        && image.mimeType.trim().startsWith('image/')
        ? {
            data: image.data.trim(),
            mimeType: image.mimeType.trim(),
        }
        : null;
}

function createToolStructuredContent(data: unknown) {
    if (!isRecord(data) || !isRecord(data.image)) {
        return data;
    }

    const imageMetadata = Object.fromEntries(
        Object.entries(data.image).filter(([key]) => key !== 'data'),
    );
    return {
        ...data,
        image: imageMetadata,
    };
}

function createToolResult(data: unknown) {
    const structuredContent = createToolStructuredContent(data);
    const content: TMcpToolContent[] = [{
        type: 'text',
        text: JSON.stringify(structuredContent, null, 2),
    }];
    const image = getMcpImagePayload(data);
    if (image) {
        content.push({
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
        });
    }

    return {
        content,
        structuredContent,
    };
}

function createInitializeMetadata(identity: ILocalMcpServerIdentity) {
    return {evb: {
        appName: identity.appName,
        isPackaged: identity.isPackaged,
        userDataPath: identity.userDataPath,
        mcp: {
            host: identity.host,
            port: identity.port,
        },
    }};
}

export function createHealthResponse(identity: ILocalMcpServerIdentity) {
    return {
        ok: true,
        ...identity,
        tools: MCP_TOOLS.map(tool => tool.name),
        resources: [
            'evb://workspace/current',
            ...MCP_RESOURCE_TEMPLATES.map(template => template.uriTemplate),
        ],
        prompts: MCP_PROMPTS.map(prompt => prompt.name),
    };
}

function createInitializeInstructions() {
    return [
        'EVB Viewer exposes the live workspace. A document may or may not be open; inspect the workspace before answering questions about open tabs, current pages, or document contents.',
        'Use the compact capability workflow: evb_workspace_snapshot for state; evb_list_capabilities to discover actions; evb_describe_capability for schemas, policy, and availability; evb_read_resource for notes, annotations, bookmarks, page labels, page text, and OCR status; evb_run_action for app actions.',
        'Use semantic capability ids through evb_run_action: document.open_documents, document.readiness, document.inspect_text, document.search, document.read_pages, document.capture_page_image, view.go_to_page, annotation.*, page_labels.*, bookmarks.*, ocr.*, and file.save.',
        'Recent files in workspace snapshots are metadata only; do not summarize contents until opened and read through EVB tools.',
        'For search/navigation, search first, read candidate pages, then navigate only after selecting the best page. If text is missing or visual evidence matters, inspect text coverage or capture a page image.',
        'For annotations, use direct create/update capabilities instead of only selecting toolbar tools. Read annotation/note resources first when updating existing content.',
        'For page labels and bookmarks, read existing state, verify against text and screenshots when uncertain, preview first, apply only verified plans, re-read after writes, then save with file.save.',
        'For OCR, use ocr.status before acting, ocr.open_popup for visible controls, and ocr.start only after explicit user request or policy approval.',
        'For writes, destructive actions, or long-running actions, inspect policy/availability and prefer dryRun or preview when supported. For DjVu or image documents, recommend converting to PDF before deep text analysis.',
    ].join('\n');
}

function getOptionalCapabilityDomain(params: unknown): TAgentCapabilityDomain | undefined {
    const value = getParamsObject(params).domain;
    return typeof value === 'string' && AGENT_CAPABILITY_TEMPLATES.some(template => template.domain === value)
        ? value as TAgentCapabilityDomain
        : undefined;
}

function getRequiredCapabilityId(params: unknown) {
    const value = getParamsObject(params).id;
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('Capability id is required.');
    }
    return value.trim();
}

function getOptionalActionInput(params: unknown) {
    const input = getParamsObject(params).input;
    return isRecord(input) ? input : undefined;
}

function getCapabilityTemplate(id: string) {
    return AGENT_CAPABILITY_TEMPLATES.find(template => template.id === id) ?? null;
}

function findCapabilityTargetTab(snapshot: IAgentWorkspaceSnapshot, tabId?: string) {
    const targetTabId = tabId ?? snapshot.activeTabId;
    if (!targetTabId) {
        return null;
    }
    return snapshot.tabs.find(tab => tab.tabId === targetTabId) ?? null;
}

function createCapabilityAvailability(
    template: IAgentCapabilityTemplate,
    tab: IAgentTabSnapshot | null,
) {
    if (template.availabilityKind === 'always') {
        return {available: true};
    }

    if (!tab) {
        return {
            available: false,
            reason: 'No target tab is available.',
        };
    }

    if (template.availabilityKind === 'document' && !isAgentDocumentTab(tab)) {
        return {
            available: false,
            reason: `Tab ${tab.tabId} does not have an open document.`,
        };
    }

    if ((template.availabilityKind === 'pdf' || template.availabilityKind === 'pdf-path') && tab.kind !== 'pdf') {
        return {
            available: false,
            reason: `Tab ${tab.tabId} is a ${tab.kind} document; convert/open it as PDF first.`,
        };
    }

    if (template.availabilityKind === 'pdf-path' && !tab.originalPath) {
        return {
            available: false,
            reason: `Tab ${tab.tabId} does not expose a readable PDF path yet.`,
        };
    }

    if (template.availabilityKind === 'renderer-document' || template.availabilityKind === 'renderer-pdf') {
        if (!isAgentDocumentTab(tab)) {
            return {
                available: false,
                reason: `Tab ${tab.tabId} does not have an open document.`,
            };
        }
        if (!tab.workspaceAttached) {
            return {
                available: false,
                reason: `Workspace for tab ${tab.tabId} is not attached yet.`,
            };
        }
    }

    if (template.availabilityKind === 'renderer-pdf' && tab.kind !== 'pdf') {
        return {
            available: false,
            reason: `Tab ${tab.tabId} is a ${tab.kind} document; convert/open it as PDF first.`,
        };
    }

    return {available: true};
}

function createCapabilityDescriptor(
    template: IAgentCapabilityTemplate,
    tab: IAgentTabSnapshot | null,
): IAgentCapabilityDescriptor {
    return {
        id: template.id,
        domain: template.domain,
        title: template.title,
        summary: template.summary,
        risk: template.risk,
        inputSchema: template.inputSchema,
        ...(template.outputSchema === undefined ? {} : {outputSchema: template.outputSchema}),
        policy: template.policy,
        ...(template.resourceTemplates === undefined ? {} : {resourceTemplates: template.resourceTemplates}),
        availability: createCapabilityAvailability(template, tab),
    };
}

async function listAgentCapabilities(params: unknown, options: IProcessMcpRequestOptions) {
    const windowId = getOptionalWindowId(params);
    const snapshot = await options.getWorkspaceSnapshot(windowId);
    const targetTab = findCapabilityTargetTab(snapshot, getOptionalTabId(params));
    const domain = getOptionalCapabilityDomain(params);
    const capabilities = AGENT_CAPABILITY_TEMPLATES
        .filter(template => domain === undefined || template.domain === domain)
        .map(template => createCapabilityDescriptor(template, targetTab));
    return {
        activeTabId: snapshot.activeTabId,
        targetTabId: targetTab?.tabId ?? null,
        domain: domain ?? null,
        capabilityCount: capabilities.length,
        capabilities,
    };
}

async function describeAgentCapability(params: unknown, options: IProcessMcpRequestOptions) {
    const id = getRequiredCapabilityId(params);
    const template = getCapabilityTemplate(id);
    if (!template) {
        throw new Error(`Unknown EVB capability: ${id}`);
    }

    const windowId = getOptionalWindowId(params);
    const snapshot = await options.getWorkspaceSnapshot(windowId);
    const targetTab = findCapabilityTargetTab(snapshot, getOptionalTabId(params));
    return {
        activeTabId: snapshot.activeTabId,
        targetTabId: targetTab?.tabId ?? null,
        capability: createCapabilityDescriptor(template, targetTab),
    };
}

function getRequiredCapability<TCapability>(
    capability: TCapability | undefined,
    name: string,
) {
    if (!capability) {
        throw new Error(`${name} is not available in this EVB Viewer MCP session.`);
    }
    return capability;
}

function getParamsObject(params: unknown) {
    return isRecord(params) ? params : {};
}

function getOptionalWindowId(params: unknown) {
    const paramsObject = getParamsObject(params);
    return typeof paramsObject.windowId === 'number' && Number.isFinite(paramsObject.windowId)
        ? paramsObject.windowId
        : undefined;
}

function getOptionalTabId(params: unknown) {
    const paramsObject = getParamsObject(params);
    return typeof paramsObject.tabId === 'string' && paramsObject.tabId.trim().length > 0
        ? paramsObject.tabId.trim()
        : undefined;
}

function getRequiredTabId(params: unknown) {
    const tabId = getOptionalTabId(params);
    if (!tabId) {
        throw new Error('tabId is required.');
    }
    return tabId;
}

function getRequiredPage(params: unknown) {
    const paramsObject = getParamsObject(params);
    const page = paramsObject.page;
    if (typeof page !== 'number' || !Number.isFinite(page)) {
        throw new Error('page must be a finite number.');
    }
    return Math.max(1, Math.trunc(page));
}

function getRequiredQuery(params: unknown) {
    const paramsObject = getParamsObject(params);
    const query = typeof paramsObject.query === 'string' ? paramsObject.query.trim() : '';
    if (!query) {
        throw new Error('query is required.');
    }
    return query;
}

function getRequiredResourceUri(params: unknown) {
    const uri = getParamsObject(params).uri;
    if (typeof uri !== 'string' || uri.trim().length === 0) {
        throw new Error('uri is required.');
    }
    return uri.trim();
}

function getOptionalBoolean(params: unknown, key: string) {
    const value = getParamsObject(params)[key];
    return typeof value === 'boolean' ? value : undefined;
}

function getOptionalFiniteNumber(params: unknown, key: string) {
    const value = getParamsObject(params)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizePageNumber(value: unknown, pageCount: number | null = null) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }

    const page = Math.max(1, Math.trunc(value));
    return pageCount === null
        ? page
        : Math.min(page, pageCount);
}

function getTabPageCount(tab: IAgentTabSnapshot) {
    return typeof tab.totalPages === 'number' && Number.isFinite(tab.totalPages) && tab.totalPages > 0
        ? Math.trunc(tab.totalPages)
        : null;
}

function assertReadPageBudget(pageCount: number) {
    if (pageCount > MAX_READ_DOCUMENT_PAGES_PER_REQUEST) {
        throw new Error(`Too many pages requested; maximum is ${MAX_READ_DOCUMENT_PAGES_PER_REQUEST}.`);
    }
}

function addReadPage(pages: Set<number>, page: number) {
    pages.add(page);
    assertReadPageBudget(pages.size);
}

function getReadPages(params: unknown, fallbackPage: number | null, pageCount: number | null) {
    const paramsObject = getParamsObject(params);
    const pages = new Set<number>();
    if (Array.isArray(paramsObject.pages)) {
        for (const page of paramsObject.pages) {
            const normalizedPage = normalizePageNumber(page, pageCount);
            if (normalizedPage !== null) {
                addReadPage(pages, normalizedPage);
            }
        }
    }

    const startPage = normalizePageNumber(paramsObject.startPage, pageCount);
    const endPage = normalizePageNumber(paramsObject.endPage, pageCount);
    if (startPage !== null || endPage !== null) {
        const start = startPage ?? endPage ?? 1;
        const end = endPage ?? startPage ?? start;
        const lower = Math.min(start, end);
        const upper = Math.max(start, end);
        assertReadPageBudget(upper - lower + 1);
        for (let page = lower; page <= upper; page += 1) {
            addReadPage(pages, page);
        }
    }

    if (pages.size === 0 && fallbackPage !== null) {
        addReadPage(pages, fallbackPage);
    }

    return Array.from(pages).sort((left, right) => left - right);
}

function getDocumentSearchOptions(params: unknown): IAgentDocumentSearchOptions {
    const maxResults = getOptionalFiniteNumber(params, 'maxResults');
    const matchCase = getOptionalBoolean(params, 'matchCase');
    const wholeWord = getOptionalBoolean(params, 'wholeWord');
    const useRegex = getOptionalBoolean(params, 'useRegex');
    return {
        query: getRequiredQuery(params),
        ...(maxResults === undefined ? {} : {maxResults}),
        ...(matchCase === undefined ? {} : {matchCase}),
        ...(wholeWord === undefined ? {} : {wholeWord}),
        ...(useRegex === undefined ? {} : {useRegex}),
    };
}

function getDocumentPageReadOptions(
    params: unknown,
    tab: IAgentTabSnapshot,
): IAgentDocumentPageReadOptions {
    const maxCharsPerPage = getOptionalFiniteNumber(params, 'maxCharsPerPage');
    return {
        pages: getReadPages(params, tab.currentPage, getTabPageCount(tab)),
        ...(maxCharsPerPage === undefined ? {} : {maxCharsPerPage}),
    };
}

function selectDocumentsFromSnapshot(snapshot: IAgentWorkspaceSnapshot, tabId?: string) {
    const tabs = tabId
        ? snapshot.tabs.filter(tab => tab.tabId === tabId)
        : snapshot.tabs;
    return {
        activePaneId: snapshot.activePaneId,
        activeTabId: snapshot.activeTabId,
        tabs,
    };
}

function isAgentDocumentTab(tab: IAgentTabSnapshot) {
    return tab.kind !== 'empty'
        && (
            Boolean(tab.fileName)
            || Boolean(tab.originalPath)
            || tab.hasPdf === true
            || tab.isDjvu === true
        );
}

function createOpenDocumentsResponse(snapshot: IAgentWorkspaceSnapshot) {
    const documents = snapshot.tabs
        .filter(isAgentDocumentTab)
        .map(tab => ({
            tabId: tab.tabId,
            paneId: tab.paneId,
            isActive: tab.tabId === snapshot.activeTabId,
            fileName: tab.fileName,
            originalPath: tab.originalPath,
            kind: tab.kind,
            currentPage: tab.currentPage,
            totalPages: tab.totalPages,
            isDirty: tab.isDirty,
            readiness: tab.readiness,
        }));

    return {
        workspaceMode: snapshot.summary.mode,
        hasOpenDocument: documents.length > 0,
        documentCount: documents.length,
        activePaneId: snapshot.activePaneId,
        activeTabId: snapshot.activeTabId,
        activeDocument: documents.find(document => document.isActive) ?? null,
        documents,
        recentFilesResolved: snapshot.summary.recentFilesResolved,
        recentFileCount: snapshot.recentFiles.length,
        recentFiles: snapshot.recentFiles,
        panes: snapshot.panes.map(pane => ({
            paneId: pane.paneId,
            activeTabId: pane.activeTabId,
            tabIds: pane.tabIds,
        })),
    };
}

function getTargetTab(snapshot: IAgentWorkspaceSnapshot, tabId?: string) {
    const resolvedTabId = tabId ?? snapshot.activeTabId;
    if (!resolvedTabId) {
        throw new Error('No active tab is available.');
    }

    const tab = snapshot.tabs.find(candidate => candidate.tabId === resolvedTabId);
    if (!tab) {
        throw new Error(`Tab ${resolvedTabId} is not open.`);
    }
    return tab;
}

async function getTargetTabFromParams(
    params: unknown,
    options: IProcessMcpRequestOptions,
) {
    const windowId = getOptionalWindowId(params);
    const snapshot = await options.getWorkspaceSnapshot(windowId);
    return {
        windowId,
        snapshot,
        tab: getTargetTab(snapshot, getOptionalTabId(params)),
    };
}

function createActionParams(params: unknown) {
    const input = getOptionalActionInput(params) ?? {};
    const tabId = getOptionalTabId(params);
    return {
        ...input,
        ...(tabId ? {tabId} : {}),
    };
}

function getMcpCallerKind(options: IProcessMcpRequestOptions): TMcpCallerKind {
    return options.callerKind ?? 'internal';
}

function enforceCapabilityPolicy(template: IAgentCapabilityTemplate, options: IProcessMcpRequestOptions) {
    const callerKind = getMcpCallerKind(options);
    const decision = template.policy[callerKind];
    if (decision === 'allow') {
        return;
    }

    if (decision === 'confirm') {
        throw new Error(`Capability ${template.id} requires explicit user confirmation for ${callerKind} MCP callers.`);
    }

    throw new Error(`Capability ${template.id} is not allowed for ${callerKind} MCP callers.`);
}

async function runAgentActionTool(params: unknown, options: IProcessMcpRequestOptions) {
    const id = getRequiredCapabilityId(params);
    const template = getCapabilityTemplate(id);
    if (!template) {
        throw new Error(`Unknown EVB capability: ${id}`);
    }
    enforceCapabilityPolicy(template, options);

    const windowId = getOptionalWindowId(params);
    const actionParams = createActionParams(params);
    if (id === 'workspace.snapshot') {
        return options.getWorkspaceSnapshot(windowId);
    }

    if (id === 'document.open_documents') {
        return createOpenDocumentsResponse(await options.getWorkspaceSnapshot(windowId));
    }

    if (id === 'document.readiness') {
        const snapshot = await options.getWorkspaceSnapshot(windowId);
        return selectDocumentsFromSnapshot(snapshot, getOptionalTabId(actionParams));
    }

    if (id === 'document.inspect_text') {
        const {tab} = await getTargetTabFromParams(actionParams, options);
        const inspectDocumentText = getRequiredCapability(options.inspectDocumentText, id);
        return inspectDocumentText({
            tab,
            options: {},
        }, windowId);
    }

    if (id === 'document.search') {
        const {tab} = await getTargetTabFromParams(actionParams, options);
        const searchDocument = getRequiredCapability(options.searchDocument, id);
        return searchDocument({
            tab,
            options: getDocumentSearchOptions(actionParams),
        }, windowId);
    }

    if (id === 'document.read_pages') {
        const {tab} = await getTargetTabFromParams(actionParams, options);
        const readDocumentPages = getRequiredCapability(options.readDocumentPages, id);
        return readDocumentPages({
            tab,
            options: getDocumentPageReadOptions(actionParams, tab),
        }, windowId);
    }

    if (
        id === 'toc.read'
        || id === 'bookmarks.read'
        || id === 'page_labels.read'
        || id === 'annotation.list'
        || id === 'annotation.list_notes'
    ) {
        const snapshot = await options.getWorkspaceSnapshot(windowId);
        const tab = getTargetTab(snapshot, getOptionalTabId(actionParams));
        let resourceKind = 'notes';
        if (id === 'toc.read') {
            resourceKind = 'toc';
        } else if (id === 'bookmarks.read') {
            resourceKind = 'bookmarks';
        } else if (id === 'page_labels.read') {
            resourceKind = 'page-labels';
        } else if (id === 'annotation.list') {
            resourceKind = 'annotations';
        }
        const resource = await readMcpResource({
            windowId,
            uri: `evb://document/${encodeURIComponent(tab.tabId)}/${resourceKind}`,
        }, options);
        const content = Array.isArray(resource.contents) ? resource.contents[0] : null;
        if (isRecord(content) && typeof content.text === 'string') {
            const parsed: unknown = JSON.parse(content.text);
            return parsed;
        }
        return resource;
    }

    if (id === 'view.activate_tab') {
        return options.runCommand({
            name: 'activate_tab',
            arguments: {tabId: getRequiredTabId(actionParams)},
        }, windowId);
    }

    if (id === 'view.go_to_page') {
        const tabId = getOptionalTabId(actionParams);
        const command: TAgentCommand = {
            name: 'go_to_page',
            arguments: {
                page: getRequiredPage(actionParams),
                ...(tabId ? {tabId} : {}),
            },
        };
        return options.runCommand(command, windowId);
    }

    const tabId = getOptionalTabId(params);
    const input = getOptionalActionInput(params);
    const dryRun = getOptionalBoolean(params, 'dryRun');
    const actionCommand: TAgentCommand = {
        name: 'run_action',
        arguments: {
            id,
            ...(tabId ? {tabId} : {}),
            ...(input ? {input} : {}),
            ...(dryRun === undefined ? {} : {dryRun}),
        },
    };
    return options.runCommand(actionCommand, windowId);
}

function getJobStatus(params: unknown) {
    const jobId = getParamsObject(params).jobId;
    return {
        ok: true,
        jobId: typeof jobId === 'string' && jobId.trim().length > 0 ? jobId.trim() : null,
        status: 'not-found',
        tracked: false,
        message: 'No tracked EVB MCP job was found. OCR progress is available through evb_run_action with id ocr.status; other EVB MCP actions complete inline or expose progress in the EVB Viewer UI.',
    };
}

async function callTool(name: string, params: unknown, options: IProcessMcpRequestOptions) {
    const windowId = getOptionalWindowId(params);
    if (name === 'evb_list_capabilities') {
        return createToolResult(await listAgentCapabilities(params, options));
    }

    if (name === 'evb_describe_capability') {
        return createToolResult(await describeAgentCapability(params, options));
    }

    if (name === 'evb_read_resource') {
        return createToolResult(await readMcpResource({
            windowId,
            uri: getRequiredResourceUri(params),
        }, options));
    }

    if (name === 'evb_run_action') {
        return createToolResult(await runAgentActionTool(params, options));
    }

    if (name === 'evb_job_status') {
        return createToolResult(getJobStatus(params));
    }

    if (name === 'evb_workspace_snapshot') {
        return createToolResult(await options.getWorkspaceSnapshot(windowId));
    }

    if (name === 'evb_viewer_open_documents') {
        return createToolResult(createOpenDocumentsResponse(await options.getWorkspaceSnapshot(windowId)));
    }

    if (name === 'evb_document_readiness') {
        const snapshot = await options.getWorkspaceSnapshot(windowId);
        return createToolResult(selectDocumentsFromSnapshot(snapshot, getOptionalTabId(params)));
    }

    if (name === 'evb_inspect_document_text') {
        const {tab} = await getTargetTabFromParams(params, options);
        const inspectDocumentText = getRequiredCapability(options.inspectDocumentText, 'evb_inspect_document_text');
        return createToolResult(await inspectDocumentText({
            tab,
            options: {},
        }, windowId));
    }

    if (name === 'evb_search_document' || name === 'evb_viewer_search_open_document') {
        const {tab} = await getTargetTabFromParams(params, options);
        const searchDocument = getRequiredCapability(options.searchDocument, name);
        return createToolResult(await searchDocument({
            tab,
            options: getDocumentSearchOptions(params),
        }, windowId));
    }

    if (name === 'evb_read_document_pages') {
        const {tab} = await getTargetTabFromParams(params, options);
        const readDocumentPages = getRequiredCapability(options.readDocumentPages, 'evb_read_document_pages');
        return createToolResult(await readDocumentPages({
            tab,
            options: getDocumentPageReadOptions(params, tab),
        }, windowId));
    }

    if (name === 'evb_activate_tab') {
        return createToolResult(await options.runCommand({
            name: 'activate_tab',
            arguments: { tabId: getRequiredTabId(params) },
        }, windowId));
    }

    if (name === 'evb_go_to_page') {
        const tabId = getOptionalTabId(params);
        const command: TAgentCommand = {
            name: 'go_to_page',
            arguments: {
                page: getRequiredPage(params),
                ...(tabId ? { tabId } : {}),
            },
        };
        return createToolResult(await options.runCommand(command, windowId));
    }

    throw new Error(`Unknown tool: ${name}`);
}

function getClientProtocolVersion(params: unknown) {
    if (!isRecord(params) || typeof params.protocolVersion !== 'string') {
        return MCP_PROTOCOL_VERSION;
    }
    return params.protocolVersion.trim() || MCP_PROTOCOL_VERSION;
}

const WORKSPACE_RESOURCE_URI = 'evb://workspace/current';

function createWorkspaceResource(): IMcpResourceDefinition {
    return {
        name: 'evb_workspace_current',
        title: 'EVB Viewer current workspace',
        uri: WORKSPACE_RESOURCE_URI,
        description: 'Live JSON snapshot of EVB Viewer panes, tabs, active document when present, page numbers, and readiness hints.',
        mimeType: 'application/json',
    };
}

function createDocumentStatusResource(tab: IAgentTabSnapshot): IMcpResourceDefinition {
    return {
        name: `evb_document_${tab.tabId.replaceAll(/[^a-zA-Z0-9_]/gu, '_')}_text_status`,
        title: `${tab.fileName ?? tab.tabId} text status`,
        uri: `evb://document/${encodeURIComponent(tab.tabId)}/text-status`,
        description: 'Searchable text coverage and OCR recommendations for this open EVB Viewer tab.',
        mimeType: 'application/json',
    };
}

function createDocumentJsonResource(
    tab: IAgentTabSnapshot,
    kind: 'ocr-status' | 'annotations' | 'notes' | 'toc' | 'bookmarks' | 'page-labels',
    titleSuffix: string,
    description: string,
): IMcpResourceDefinition {
    return {
        name: `evb_document_${tab.tabId.replaceAll(/[^a-zA-Z0-9_]/gu, '_')}_${kind.replaceAll('-', '_')}`,
        title: `${tab.fileName ?? tab.tabId} ${titleSuffix}`,
        uri: `evb://document/${encodeURIComponent(tab.tabId)}/${kind}`,
        description,
        mimeType: 'application/json',
    };
}

function createDocumentResources(tab: IAgentTabSnapshot) {
    return [
        createDocumentStatusResource(tab),
        createDocumentJsonResource(
            tab,
            'ocr-status',
            'OCR status',
            'OCR/searchable text coverage and recommendations for this open EVB Viewer tab.',
        ),
        createDocumentJsonResource(
            tab,
            'annotations',
            'annotations',
            'Annotation summaries with stable keys, pages, subtype, colors, and note flags.',
        ),
        createDocumentJsonResource(
            tab,
            'notes',
            'notes',
            'Note-bearing annotations and open note-window state for this EVB Viewer tab.',
        ),
        createDocumentJsonResource(
            tab,
            'toc',
            'TOC',
            'Document TOC/bookmarks with titles and one-based page numbers when present.',
        ),
        createDocumentJsonResource(
            tab,
            'bookmarks',
            'bookmarks',
            'Editable nested bookmark tree with zero-based paths and one-based page numbers.',
        ),
        createDocumentJsonResource(
            tab,
            'page-labels',
            'page labels',
            'Page numbering ranges and materialized page labels for this EVB Viewer tab.',
        ),
    ];
}

async function listMcpResources(options: IProcessMcpRequestOptions) {
    const snapshot = await options.getWorkspaceSnapshot();
    return {resources: [
        createWorkspaceResource(),
        ...snapshot.tabs
            .filter(tab => tab.kind === 'pdf' && isAgentDocumentTab(tab))
            .flatMap(createDocumentResources),
    ]};
}

function parseResourceUri(uri: unknown) {
    if (typeof uri !== 'string' || uri.trim().length === 0) {
        throw new Error('resources/read requires params.uri.');
    }

    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        throw new Error(`Invalid EVB resource URI: ${uri}`);
    }

    if (parsed.protocol !== 'evb:') {
        throw new Error(`Unsupported resource URI protocol: ${parsed.protocol}`);
    }

    const parts = parsed.pathname
        .split('/')
        .filter(Boolean)
        .map(part => decodeURIComponent(part));
    return {
        uri,
        host: parsed.hostname,
        parts,
    };
}

function createTextResourceContent(uri: string, text: string, mimeType: string) {
    return {
        uri,
        mimeType,
        text,
    };
}

async function readMcpResource(
    params: unknown,
    options: IProcessMcpRequestOptions,
) {
    const windowId = getOptionalWindowId(params);
    const parsed = parseResourceUri(getParamsObject(params).uri);
    if (parsed.host === 'workspace' && parsed.parts[0] === 'current') {
        const snapshot = await options.getWorkspaceSnapshot(windowId);
        return {contents: [createTextResourceContent(
            parsed.uri,
            JSON.stringify(snapshot, null, 2),
            'application/json',
        )]};
    }

    if (parsed.host !== 'document') {
        throw new Error(`Unknown EVB resource host: ${parsed.host}`);
    }

    const [
        tabId,
        resourceKind,
        pageToken,
    ] = parsed.parts;
    if (!tabId || !resourceKind) {
        throw new Error(`Invalid EVB document resource URI: ${parsed.uri}`);
    }

    const snapshot = await options.getWorkspaceSnapshot(windowId);
    const tab = getTargetTab(snapshot, tabId);
    if (resourceKind === 'text-status' || resourceKind === 'ocr-status') {
        const inspectDocumentText = getRequiredCapability(options.inspectDocumentText, 'resources/read text-status');
        const result = await inspectDocumentText({
            tab,
            options: {},
        }, windowId);
        return {contents: [createTextResourceContent(
            parsed.uri,
            JSON.stringify(result, null, 2),
            'application/json',
        )]};
    }

    if (resourceKind === 'page') {
        const page = normalizePageNumber(Number(pageToken));
        if (page === null) {
            throw new Error(`Invalid EVB document page resource URI: ${parsed.uri}`);
        }
        const readDocumentPages = getRequiredCapability(options.readDocumentPages, 'resources/read page');
        const result = await readDocumentPages({
            tab,
            options: {pages: [page]},
        }, windowId);
        const pages: unknown[] = Array.isArray(result.pages) ? result.pages : [];
        const pageResult = pages.find(candidate => isRecord(candidate) && candidate.page === page);
        const text = isRecord(pageResult) && typeof pageResult.text === 'string'
            ? pageResult.text
            : '';
        return {contents: [createTextResourceContent(parsed.uri, text, 'text/plain')]};
    }

    if (
        resourceKind === 'annotations'
        || resourceKind === 'notes'
        || resourceKind === 'toc'
        || resourceKind === 'bookmarks'
        || resourceKind === 'page-labels'
        || resourceKind === 'page-numbering'
    ) {
        const result = await options.runCommand({
            name: 'read_resource',
            arguments: {
                tabId: tab.tabId,
                uri: parsed.uri,
            },
        }, windowId);
        return {contents: [createTextResourceContent(
            parsed.uri,
            JSON.stringify(result, null, 2),
            'application/json',
        )]};
    }

    throw new Error(`Unknown EVB document resource kind: ${resourceKind}`);
}

function getPromptName(params: unknown) {
    const name = getParamsObject(params).name;
    if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error('prompts/get requires params.name.');
    }
    return name.trim();
}

function getPromptArgument(params: unknown, key: string) {
    const args = getParamsObject(params).arguments;
    if (!isRecord(args)) {
        return '';
    }
    const value = args[key];
    return typeof value === 'string' ? value.trim() : '';
}

function createPromptText(name: string, params: unknown) {
    if (name === 'evb_find_in_current_pdf') {
        const topic = getPromptArgument(params, 'topic') || '<topic>';
        return [
            `Find "${topic}" in the active EVB Viewer PDF.`,
            'Use evb_workspace_snapshot to identify the active tab.',
            'Call evb_run_action with document.search and a small set of likely query variants; inspect candidate pages with document.read_pages.',
            'Navigate with view.go_to_page only after choosing the best page. If text coverage is missing, call document.inspect_text and recommend OCR all pages.',
        ].join('\n');
    }

    if (name === 'evb_number_pages_from_printed_pages') {
        return [
            'Reconstruct the PDF page labels from the printed page numbers.',
            'Start by reading evb://document/{tabId}/page-labels and inspecting text coverage with document.inspect_text. Use OCR/searchable page text as evidence, but do not trust it blindly.',
            'Sample the beginning, front-matter/body transition, appendix or plate sections, and the end. Look for printed numerals such as iv, A, A-1, 1, or restarted numbering; search/read nearby pages to infer ranges.',
            'For every uncertain boundary or suspicious OCR result, call document.capture_page_image with full/top/bottom or normalized crops and visually inspect the returned image before deciding.',
            'Call page_labels.preview with ranges, inclusive segments, or explicit labels. Inspect the normalized segments, samples, issues, and changed-page diff. Only then commit with page_labels.apply_plan so the app records an undoable metadata step. Re-read page labels after the write, spot-check representative pages, then save with file.save.',
        ].join('\n');
    }

    if (name === 'evb_rebuild_verified_bookmarks') {
        return [
            'Rebuild or correct PDF bookmarks from verified section starts.',
            'Start by reading evb://document/{tabId}/toc and /bookmarks. Treat the existing PDF TOC/bookmarks as hints, not proof.',
            'Use document.search and document.read_pages to locate each section title from the TOC, printed contents pages, or the user-specified outline.',
            'For doubtful title/page matches, wrong-looking offsets, duplicated headings, or OCR gaps, call document.capture_page_image on candidate pages or crops and inspect the visible page before writing.',
            'Call bookmarks.preview_tree with a nested tree or flat entries that carry level/depth values. Inspect the normalized tree, flat path list, issues, and diff. Only then commit with bookmarks.apply_plan so the app records an undoable metadata step. Re-read bookmarks, verify a sample of root and nested targets after the write, then save with file.save.',
        ].join('\n');
    }

    if (name === 'evb_check_document_prep') {
        return [
            'Check whether the active EVB Viewer document is agent-ready.',
            'Use evb_workspace_snapshot and evb_run_action with document.open_documents or document.readiness first.',
            'For PDFs, call document.inspect_text through evb_run_action to compute searchable text coverage.',
            'If coverage is partial or none, explain that OCR all pages is recommended. If the document is DjVu or image, recommend converting to PDF first.',
        ].join('\n');
    }

    throw new Error(`Unknown prompt: ${name}`);
}

function getMcpPrompt(params: unknown) {
    const name = getPromptName(params);
    const prompt = MCP_PROMPTS.find(candidate => candidate.name === name);
    if (!prompt) {
        throw new Error(`Unknown prompt: ${name}`);
    }

    return {
        description: prompt.description,
        messages: [{
            role: 'user',
            content: {
                type: 'text',
                text: createPromptText(name, params),
            },
        }],
    };
}

export async function processMcpRequest(
    rawRequest: unknown,
    options: IProcessMcpRequestOptions,
): Promise<IJsonRpcResponse | null> {
    if (!isRecord(rawRequest)) {
        return createErrorResponse(null, -32600, 'Invalid JSON-RPC request.');
    }

    const request = rawRequest as IJsonRpcRequest;
    const id = getJsonRpcId(request.id);
    const isNotification = request.id === undefined;
    const method = typeof request.method === 'string' ? request.method : '';

    if (!method) {
        return createErrorResponse(id, -32600, 'JSON-RPC method is required.');
    }

    if (method === 'notifications/initialized') {
        return null;
    }

    try {
        if (method === 'initialize') {
            return createResultResponse(id, {
                protocolVersion: getClientProtocolVersion(request.params),
                capabilities: {
                    tools: {listChanged: false},
                    resources: {
                        subscribe: false,
                        listChanged: false,
                    },
                    prompts: {listChanged: false},
                },
                serverInfo: {
                    name: options.identity.name,
                    title: options.identity.title,
                    version: options.identity.version,
                },
                instructions: createInitializeInstructions(),
                _meta: createInitializeMetadata(options.identity),
            });
        }

        if (method === 'tools/list') {
            return createResultResponse(id, { tools: MCP_TOOLS });
        }

        if (method === 'tools/call') {
            const params = getParamsObject(request.params);
            const toolName = typeof params.name === 'string' ? params.name : '';
            if (!toolName) {
                return createErrorResponse(id, -32602, 'tools/call requires params.name.');
            }

            const result = await callTool(toolName, params.arguments, options);
            return createResultResponse(id, result);
        }

        if (method === 'resources/list') {
            return createResultResponse(id, await listMcpResources(options));
        }

        if (method === 'resources/templates/list') {
            return createResultResponse(id, {resourceTemplates: MCP_RESOURCE_TEMPLATES});
        }

        if (method === 'resources/read') {
            return createResultResponse(id, await readMcpResource(request.params, options));
        }

        if (method === 'prompts/list') {
            return createResultResponse(id, {prompts: MCP_PROMPTS});
        }

        if (method === 'prompts/get') {
            return createResultResponse(id, getMcpPrompt(request.params));
        }

        if (isNotification) {
            return null;
        }

        return createErrorResponse(id, -32601, `Method not found: ${method}`);
    } catch (error) {
        return createErrorResponse(id, -32603, getErrorMessage(error));
    }
}
