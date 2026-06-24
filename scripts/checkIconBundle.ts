import type { Dirent } from 'node:fs';
import {
    readdir,
    readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import {
    parse as parseBabel,
    parseExpression,
    type ParserPlugin,
} from '@babel/parser';
import {
    sortBy,
    uniq,
} from 'es-toolkit/array';
import {
    NodeTypes,
    parse as parseVueTemplate,
} from '@vue/compiler-dom';
import type { PackageJson } from 'type-fest';

interface IProjectTarget {
    label: TProjectTargetLabel;
    configPath: string;
    sourceDirectories: string[];
}

type TProjectTargetLabel = 'app' | 'landing';
type TProjectTargetFilter = TProjectTargetLabel | 'all';

interface IQuotedTokenMatch {
    token: string;
    tokenStartIndex: number;
}

export interface ICollectionHints {
    knownCollections: Set<string>;
    orderedCollections: string[];
}

interface ITokenCandidate {
    token: string;
    allowUnknownCollection: boolean;
}

interface IBabelNodeLike {
    type: string;
    [key: string]: unknown;
}

interface IVueNodeLike {
    type: number;
    [key: string]: unknown;
}

interface IVueSfcBlocks {
    scriptBlocks: string[];
    templateBlocks: string[];
}

const SOURCE_FILE_EXTENSIONS = new Set([
    '.vue',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
]);

const QUOTED_TOKEN_PATTERN = /['"`]([a-z0-9:-]+)['"`]/giu;
const TEMPLATE_ICON_ATTRIBUTE_PATTERN = /(^|[\s<])(:)?(icon|name|leading-icon|trailing-icon|leadingIcon|trailingIcon)\s*=\s*(["'])([\s\S]*?)\4/giu;
const ICON_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ICON_CLASS_PATTERN = /^i-[a-z0-9]+(?:-[a-z0-9]+)+$/u;
const ICON_CONTEXT_NAMES = new Set([
    'icon',
    'name',
    'leading-icon',
    'trailing-icon',
    'leadingicon',
    'trailingicon',
]);
const BABEL_PARSER_PLUGINS: ParserPlugin[] = [
    'typescript',
    'jsx',
];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');

const PROJECT_TARGETS: IProjectTarget[] = [
    {
        label: 'app',
        configPath: path.join(projectRoot, 'nuxt.config.ts'),
        sourceDirectories: [path.join(projectRoot, 'app')],
    },
    {
        label: 'landing',
        configPath: path.join(projectRoot, 'landing', 'nuxt.config.ts'),
        sourceDirectories: [path.join(projectRoot, 'landing', 'app')],
    },
];

function parseTarget(argv = process.argv.slice(2)): TProjectTargetFilter {
    const targetArg = argv.find(argument => argument.startsWith('--target='));
    const target = targetArg?.slice('--target='.length) ?? 'all';

    if (target === 'app' || target === 'landing' || target === 'all') {
        return target;
    }

    throw new Error(`Expected --target to be one of: app, landing, all. Received "${target}".`);
}

function getProjectTargets(target: TProjectTargetFilter): IProjectTarget[] {
    return target === 'all'
        ? PROJECT_TARGETS
        : PROJECT_TARGETS.filter(projectTarget => projectTarget.label === target);
}

function formatTarget(target: TProjectTargetFilter) {
    if (target === 'all') {
        return 'app and landing';
    }

    return target;
}

function toRelative(filePath: string) {
    return path.relative(projectRoot, filePath);
}

function uniqueSorted(values: Iterable<string>): string[] {
    return sortBy(
        uniq(Array.from(values)).map(value => ({ value })),
        ['value'],
    ).map(item => item.value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    return value as Record<string, unknown>;
}

function isBabelNodeLike(value: unknown): value is IBabelNodeLike {
    const record = asRecord(value);
    return record !== null && typeof record.type === 'string';
}

function isVueNodeLike(value: unknown): value is IVueNodeLike {
    const record = asRecord(value);
    return record !== null && typeof record.type === 'number';
}

function normalizeContextName(name: string) {
    return name.trim().toLowerCase();
}

function isIconContextName(name: string) {
    return ICON_CONTEXT_NAMES.has(normalizeContextName(name));
}

function extractQuotedTokenMatches(content: string): IQuotedTokenMatch[] {
    const matches: IQuotedTokenMatch[] = [];
    const matcher = new RegExp(QUOTED_TOKEN_PATTERN);
    let match: RegExpExecArray | null = matcher.exec(content);

    while (match !== null) {
        const token = match[1];
        if (token) {
            matches.push({
                token,
                tokenStartIndex: match.index + 1,
            });
        }
        match = matcher.exec(content);
    }

    return matches;
}

function extractVueBlocks(content: string, tagName: 'script' | 'template'): string[] {
    const blocks: string[] = [];
    const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'giu');
    let match: RegExpExecArray | null = pattern.exec(content);

    while (match !== null) {
        const blockContent = match[1];
        if (blockContent) {
            blocks.push(blockContent);
        }
        match = pattern.exec(content);
    }

    return blocks;
}

function isLikelyScriptIconContext(content: string, tokenStartIndex: number) {
    const prefix = content.slice(Math.max(0, tokenStartIndex - 100), tokenStartIndex);
    return /(?:^|[\s,{(])(?:icon|name|leadingIcon|trailingIcon|leading-icon|trailing-icon)\s*[:=]\s*$/u.test(prefix);
}

function normalizeIconToken(
    rawToken: string,
    collectionHints: ICollectionHints,
    allowUnknownCollection: boolean,
) {
    const token = rawToken.trim().toLowerCase();

    if (ICON_NAME_PATTERN.test(token)) {
        const separatorIndex = token.indexOf(':');
        const collection = token.slice(0, separatorIndex);
        if (allowUnknownCollection || collectionHints.knownCollections.has(collection)) {
            return token;
        }
        return null;
    }

    if (!ICON_CLASS_PATTERN.test(token)) {
        return null;
    }

    const classBody = token.slice(2);
    for (const collection of collectionHints.orderedCollections) {
        if (classBody.startsWith(`${collection}-`)) {
            const iconName = classBody.slice(collection.length + 1);
            if (iconName.length > 0) {
                return `${collection}:${iconName}`;
            }
        }
    }

    if (!allowUnknownCollection) {
        return null;
    }

    const segments = classBody.split('-');
    if (segments.length < 2) {
        return null;
    }

    // Handle collections like "simple-icons" even when not present in local deps.
    if (segments.length >= 3 && segments[1] === 'icons') {
        return `${segments[0]}-${segments[1]}:${segments.slice(2).join('-')}`;
    }

    return `${segments[0]}:${segments.slice(1).join('-')}`;
}

function addUsage(
    usageByIcon: Map<string, Set<string>>,
    rawToken: string,
    filePath: string,
    collectionHints: ICollectionHints,
    allowUnknownCollection: boolean,
) {
    const normalized = normalizeIconToken(rawToken, collectionHints, allowUnknownCollection);
    if (!normalized) {
        return;
    }

    const locations = usageByIcon.get(normalized) ?? new Set<string>();
    locations.add(filePath);
    usageByIcon.set(normalized, locations);
}

function parseBabelScriptAst(content: string): IBabelNodeLike | null {
    try {
        const parsed = parseBabel(content, {
            sourceType: 'unambiguous',
            plugins: BABEL_PARSER_PLUGINS,
        });
        return isBabelNodeLike(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function parseBabelExpressionAst(expression: string): IBabelNodeLike | null {
    try {
        const parsed = parseExpression(expression, {plugins: BABEL_PARSER_PLUGINS});
        return isBabelNodeLike(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function getStaticObjectPropertyName(node: IBabelNodeLike) {
    const key = node.key;
    const computed = node.computed === true;

    if (!isBabelNodeLike(key)) {
        return null;
    }

    if (!computed && key.type === 'Identifier' && typeof key.name === 'string') {
        return key.name;
    }

    if (key.type === 'StringLiteral' && typeof key.value === 'string') {
        return key.value;
    }

    return null;
}

function getVariableDeclaratorName(node: IBabelNodeLike) {
    const idNode = node.id;
    if (!isBabelNodeLike(idNode) || idNode.type !== 'Identifier' || typeof idNode.name !== 'string') {
        return null;
    }
    return idNode.name;
}

function getStaticMemberExpressionPropertyName(node: IBabelNodeLike) {
    if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
        return null;
    }

    const propertyNode = node.property;
    const computed = node.computed === true;

    if (!isBabelNodeLike(propertyNode)) {
        return null;
    }

    if (!computed && propertyNode.type === 'Identifier' && typeof propertyNode.name === 'string') {
        return propertyNode.name;
    }

    if (computed && propertyNode.type === 'StringLiteral' && typeof propertyNode.value === 'string') {
        return propertyNode.value;
    }

    return null;
}

function isIconContextAssignmentTarget(node: unknown) {
    if (!isBabelNodeLike(node)) {
        return false;
    }

    if (node.type === 'Identifier' && typeof node.name === 'string') {
        return isIconContextName(node.name);
    }

    const staticPropertyName = getStaticMemberExpressionPropertyName(node);
    return staticPropertyName !== null && isIconContextName(staticPropertyName);
}

function getJsxAttributeName(node: IBabelNodeLike) {
    if (node.type !== 'JSXAttribute') {
        return null;
    }

    const nameNode = node.name;
    if (isBabelNodeLike(nameNode) && nameNode.type === 'JSXIdentifier' && typeof nameNode.name === 'string') {
        return nameNode.name;
    }

    return null;
}

function appendTokenCandidate(
    candidates: ITokenCandidate[],
    token: string,
    allowUnknownCollection: boolean,
) {
    candidates.push({
        token,
        allowUnknownCollection,
    });
}

function collectTokenCandidatesFromBabelNode(
    node: unknown,
    allowUnknownCollection: boolean,
    candidates: ITokenCandidate[],
) {
    if (!isBabelNodeLike(node)) {
        return;
    }

    const handled = [
        collectLiteralTokenCandidate,
        collectTemplateLiteralTokenCandidate,
        collectObjectPropertyTokenCandidates,
        collectVariableDeclaratorTokenCandidates,
        collectAssignmentTokenCandidates,
        collectJsxAttributeTokenCandidates,
    ].some(collector => collector(node, allowUnknownCollection, candidates));
    if (!handled) {
        collectChildTokenCandidates(node, allowUnknownCollection, candidates);
    }
}

function collectLiteralTokenCandidate(
    node: IBabelNodeLike,
    allowUnknownCollection: boolean,
    candidates: ITokenCandidate[],
) {
    if (node.type !== 'StringLiteral' || typeof node.value !== 'string') {
        return false;
    }

    appendTokenCandidate(candidates, node.value, allowUnknownCollection);
    return true;
}

function getStaticTemplateLiteralValue(node: IBabelNodeLike) {
    if (node.type !== 'TemplateLiteral') {
        return null;
    }

    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    const expressions = Array.isArray(node.expressions) ? node.expressions : [];
    if (expressions.length !== 0 || quasis.length !== 1) {
        return null;
    }

    const templateElement = asRecord(quasis[0]);
    const valueRecord = templateElement ? asRecord(templateElement.value) : null;
    const cookedValue = valueRecord?.cooked;
    const rawValue = valueRecord?.raw;
    return typeof cookedValue === 'string'
        ? cookedValue
        : typeof rawValue === 'string'
            ? rawValue
            : null;
}

function collectTemplateLiteralTokenCandidate(
    node: IBabelNodeLike,
    allowUnknownCollection: boolean,
    candidates: ITokenCandidate[],
) {
    const stringValue = getStaticTemplateLiteralValue(node);
    if (stringValue === null) {
        return false;
    }

    appendTokenCandidate(candidates, stringValue, allowUnknownCollection);
    return true;
}

function collectObjectPropertyTokenCandidates(
    node: IBabelNodeLike,
    allowUnknownCollection: boolean,
    candidates: ITokenCandidate[],
) {
    if (node.type !== 'ObjectProperty') {
        return false;
    }

    const propertyName = getStaticObjectPropertyName(node);
    const isIconProperty = propertyName !== null && isIconContextName(propertyName);
    collectTokenCandidatesFromBabelNode(node.value, allowUnknownCollection || isIconProperty, candidates);

    if (node.computed === true) {
        collectTokenCandidatesFromBabelNode(node.key, allowUnknownCollection, candidates);
    }
    return true;
}

function collectVariableDeclaratorTokenCandidates(
    node: IBabelNodeLike,
    allowUnknownCollection: boolean,
    candidates: ITokenCandidate[],
) {
    if (node.type !== 'VariableDeclarator') {
        return false;
    }

    const variableName = getVariableDeclaratorName(node);
    const isIconVariable = variableName !== null && isIconContextName(variableName);
    collectTokenCandidatesFromBabelNode(node.init, allowUnknownCollection || isIconVariable, candidates);
    return true;
}

function collectAssignmentTokenCandidates(
    node: IBabelNodeLike,
    allowUnknownCollection: boolean,
    candidates: ITokenCandidate[],
) {
    if (node.type !== 'AssignmentExpression') {
        return false;
    }

    const isIconAssignment = isIconContextAssignmentTarget(node.left);
    collectTokenCandidatesFromBabelNode(node.left, allowUnknownCollection, candidates);
    collectTokenCandidatesFromBabelNode(node.right, allowUnknownCollection || isIconAssignment, candidates);
    return true;
}

function collectJsxAttributeTokenCandidates(
    node: IBabelNodeLike,
    allowUnknownCollection: boolean,
    candidates: ITokenCandidate[],
) {
    if (node.type !== 'JSXAttribute') {
        return false;
    }

    const attributeName = getJsxAttributeName(node);
    const isIconAttribute = attributeName !== null && isIconContextName(attributeName);
    collectTokenCandidatesFromBabelNode(node.value, allowUnknownCollection || isIconAttribute, candidates);
    return true;
}

function collectChildTokenCandidates(
    node: IBabelNodeLike,
    allowUnknownCollection: boolean,
    candidates: ITokenCandidate[],
) {
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                collectTokenCandidatesFromBabelNode(item, allowUnknownCollection, candidates);
            }
            continue;
        }

        collectTokenCandidatesFromBabelNode(value, allowUnknownCollection, candidates);
    }
}

function extractScriptTokenCandidatesWithRegex(content: string): ITokenCandidate[] {
    return extractQuotedTokenMatches(content).map(match => ({
        token: match.token,
        allowUnknownCollection: isLikelyScriptIconContext(content, match.tokenStartIndex),
    }));
}

function extractScriptTokenCandidates(content: string): ITokenCandidate[] {
    const parsedAst = parseBabelScriptAst(content);
    if (!parsedAst) {
        return extractScriptTokenCandidatesWithRegex(content);
    }

    const candidates: ITokenCandidate[] = [];
    collectTokenCandidatesFromBabelNode(parsedAst, false, candidates);
    return candidates;
}

function getTemplateDirectiveArgumentName(node: IVueNodeLike) {
    const argNode = node.arg;
    if (!isVueNodeLike(argNode)) {
        return null;
    }

    if (argNode.type !== NodeTypes.SIMPLE_EXPRESSION || argNode.isStatic !== true || typeof argNode.content !== 'string') {
        return null;
    }

    return argNode.content;
}

function extractExpressionTokenCandidates(
    expressionContent: string,
    allowUnknownCollection: boolean,
): ITokenCandidate[] {
    const parsedExpression = parseBabelExpressionAst(expressionContent);
    if (!parsedExpression) {
        return extractQuotedTokenMatches(expressionContent).map((match) => ({
            token: match.token,
            allowUnknownCollection,
        }));
    }

    const candidates: ITokenCandidate[] = [];
    collectTokenCandidatesFromBabelNode(parsedExpression, allowUnknownCollection, candidates);
    return candidates;
}

function isTemplateIconAttributeName(attributeName: string) {
    return isIconContextName(attributeName);
}

function extractTemplateTokenCandidatesWithRegex(content: string): ITokenCandidate[] {
    const candidates: ITokenCandidate[] = [];
    const matcher = new RegExp(TEMPLATE_ICON_ATTRIBUTE_PATTERN);
    let match: RegExpExecArray | null = matcher.exec(content);

    while (match !== null) {
        const isBoundAttribute = match[2] === ':';
        const attributeValue = match[5] ?? '';

        if (isBoundAttribute) {
            for (const tokenMatch of extractQuotedTokenMatches(attributeValue)) {
                appendTokenCandidate(candidates, tokenMatch.token, true);
            }
        } else {
            appendTokenCandidate(candidates, attributeValue, true);
        }

        match = matcher.exec(content);
    }

    return candidates;
}

function walkVueNodes(node: unknown, visit: (currentNode: IVueNodeLike) => void) {
    if (!isVueNodeLike(node)) {
        return;
    }

    visit(node);

    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                walkVueNodes(item, visit);
            }
            continue;
        }

        walkVueNodes(value, visit);
    }
}

function collectTemplateAttributeTokenCandidate(
    rawProp: IVueNodeLike,
    candidates: ITokenCandidate[],
) {
    const attributeName = typeof rawProp.name === 'string' ? rawProp.name : '';
    const attributeValueNode = isVueNodeLike(rawProp.value) ? rawProp.value : null;
    const attributeValue = attributeValueNode && typeof attributeValueNode.content === 'string'
        ? attributeValueNode.content
        : null;

    if (isTemplateIconAttributeName(attributeName) && attributeValue !== null) {
        appendTokenCandidate(candidates, attributeValue, true);
    }
}

function shouldCollectTemplateBind(rawProp: IVueNodeLike) {
    const attributeName = getTemplateDirectiveArgumentName(rawProp);
    return attributeName === null || isTemplateIconAttributeName(attributeName);
}

function collectTemplateBindTokenCandidates(
    rawProp: IVueNodeLike,
    candidates: ITokenCandidate[],
) {
    const expressionNode = isVueNodeLike(rawProp.exp) ? rawProp.exp : null;
    if (!expressionNode || typeof expressionNode.content !== 'string' || !shouldCollectTemplateBind(rawProp)) {
        return;
    }

    for (const tokenCandidate of extractExpressionTokenCandidates(expressionNode.content, true)) {
        appendTokenCandidate(candidates, tokenCandidate.token, tokenCandidate.allowUnknownCollection);
    }
}

function collectTemplatePropTokenCandidates(
    rawProp: unknown,
    candidates: ITokenCandidate[],
) {
    if (!isVueNodeLike(rawProp)) {
        return;
    }

    if (rawProp.type === NodeTypes.ATTRIBUTE) {
        collectTemplateAttributeTokenCandidate(rawProp, candidates);
        return;
    }

    if (rawProp.type === NodeTypes.DIRECTIVE && rawProp.name === 'bind') {
        collectTemplateBindTokenCandidates(rawProp, candidates);
    }
}

function collectTemplateElementTokenCandidates(
    node: IVueNodeLike,
    candidates: ITokenCandidate[],
) {
    if (node.type !== NodeTypes.ELEMENT) {
        return;
    }

    const props = Array.isArray(node.props) ? node.props : [];
    for (const rawProp of props) {
        collectTemplatePropTokenCandidates(rawProp, candidates);
    }
}

function extractTemplateTokenCandidates(content: string): ITokenCandidate[] {
    let parsedTemplate: IVueNodeLike | null = null;

    try {
        const parsed = parseVueTemplate(content, { comments: false });
        parsedTemplate = isVueNodeLike(parsed) ? parsed : null;
    } catch {
        return extractTemplateTokenCandidatesWithRegex(content);
    }
    if (!parsedTemplate) {
        return extractTemplateTokenCandidatesWithRegex(content);
    }

    const candidates: ITokenCandidate[] = [];

    walkVueNodes(parsedTemplate, (node) => {
        collectTemplateElementTokenCandidates(node, candidates);
    });

    return candidates;
}

function parseVueSfcBlocks(content: string): IVueSfcBlocks {
    return {
        scriptBlocks: extractVueBlocks(content, 'script'),
        templateBlocks: extractVueBlocks(content, 'template'),
    };
}

function collectScriptUsages(
    content: string,
    filePath: string,
    usageByIcon: Map<string, Set<string>>,
    collectionHints: ICollectionHints,
) {
    for (const tokenCandidate of extractScriptTokenCandidates(content)) {
        addUsage(
            usageByIcon,
            tokenCandidate.token,
            filePath,
            collectionHints,
            tokenCandidate.allowUnknownCollection,
        );
    }
}

function collectTemplateUsages(
    content: string,
    filePath: string,
    usageByIcon: Map<string, Set<string>>,
    collectionHints: ICollectionHints,
) {
    for (const tokenCandidate of extractTemplateTokenCandidates(content)) {
        addUsage(
            usageByIcon,
            tokenCandidate.token,
            filePath,
            collectionHints,
            tokenCandidate.allowUnknownCollection,
        );
    }
}

export function createCollectionHints(collections: Iterable<string>): ICollectionHints {
    const orderedCollections = uniqueSorted(collections).sort((left, right) => right.length - left.length);
    return {
        knownCollections: new Set<string>(orderedCollections),
        orderedCollections,
    };
}

function collectVueSfcUsages(
    sourceContent: string,
    filePath: string,
    usageByIcon: Map<string, Set<string>>,
    collectionHints: ICollectionHints,
) {
    const parsedBlocks = parseVueSfcBlocks(sourceContent);
    for (const scriptBlock of parsedBlocks.scriptBlocks) {
        collectScriptUsages(scriptBlock, filePath, usageByIcon, collectionHints);
    }
    for (const templateBlock of parsedBlocks.templateBlocks) {
        collectTemplateUsages(templateBlock, filePath, usageByIcon, collectionHints);
    }
}

export function extractIconsFromScriptContent(
    content: string,
    collectionHints: ICollectionHints,
): string[] {
    const usageByIcon = new Map<string, Set<string>>();
    collectScriptUsages(content, '__inline-script__', usageByIcon, collectionHints);
    return uniqueSorted(usageByIcon.keys());
}

export function extractIconsFromTemplateContent(
    content: string,
    collectionHints: ICollectionHints,
): string[] {
    const usageByIcon = new Map<string, Set<string>>();
    collectTemplateUsages(content, '__inline-template__', usageByIcon, collectionHints);
    return uniqueSorted(usageByIcon.keys());
}

export function extractIconsFromVueSfcContent(
    content: string,
    collectionHints: ICollectionHints,
): string[] {
    const usageByIcon = new Map<string, Set<string>>();
    collectVueSfcUsages(content, '__inline-sfc__.vue', usageByIcon, collectionHints);
    return uniqueSorted(usageByIcon.keys());
}

async function collectFilesRecursively(directoryPath: string): Promise<string[]> {
    let entries: Dirent[];

    try {
        entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }

    const filePaths: string[] = [];

    for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
            const nestedFiles = await collectFilesRecursively(entryPath);
            filePaths.push(...nestedFiles);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const extension = path.extname(entry.name).toLowerCase();
        if (SOURCE_FILE_EXTENSIONS.has(extension)) {
            filePaths.push(entryPath);
        }
    }

    return filePaths;
}

function getObjectExpressionPropertyValue(node: unknown, propertyName: string) {
    if (!isBabelNodeLike(node) || node.type !== 'ObjectExpression' || !Array.isArray(node.properties)) {
        return null;
    }

    for (const property of node.properties) {
        if (!isBabelNodeLike(property) || property.type !== 'ObjectProperty') {
            continue;
        }
        if (getStaticObjectPropertyName(property) === propertyName) {
            return property.value;
        }
    }

    return null;
}

function getStaticStringValue(node: unknown) {
    if (!isBabelNodeLike(node)) {
        return null;
    }

    if (node.type === 'StringLiteral' && typeof node.value === 'string') {
        return node.value;
    }

    return getStaticTemplateLiteralValue(node);
}

function addBundledIcon(icons: Set<string>, rawIcon: string) {
    const icon = rawIcon.trim().toLowerCase();
    if (ICON_NAME_PATTERN.test(icon)) {
        icons.add(icon);
    }
}

function collectIconArrayValues(node: unknown, icons: Set<string>) {
    if (!isBabelNodeLike(node) || node.type !== 'ArrayExpression' || !Array.isArray(node.elements)) {
        return;
    }

    for (const element of node.elements) {
        const icon = getStaticStringValue(element);
        if (icon !== null) {
            addBundledIcon(icons, icon);
        }
    }
}

function collectIconClientBundleIcons(node: unknown, icons: Set<string>) {
    if (!isBabelNodeLike(node)) {
        return;
    }

    if (node.type === 'ObjectProperty' && getStaticObjectPropertyName(node) === 'icon') {
        const clientBundleNode = getObjectExpressionPropertyValue(node.value, 'clientBundle');
        const iconsNode = getObjectExpressionPropertyValue(clientBundleNode, 'icons');
        collectIconArrayValues(iconsNode, icons);
    }

    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                collectIconClientBundleIcons(item, icons);
            }
            continue;
        }

        collectIconClientBundleIcons(value, icons);
    }
}

export function extractBundledIconsFromConfig(configContent: string): Set<string> {
    const bundledIcons = new Set<string>();
    const parsedAst = parseBabelScriptAst(configContent);
    if (!parsedAst) {
        return bundledIcons;
    }
    collectIconClientBundleIcons(parsedAst, bundledIcons);
    return bundledIcons;
}

function extractCollections(icons: Iterable<string>): Set<string> {
    const collections = new Set<string>();
    for (const icon of icons) {
        const separatorIndex = icon.indexOf(':');
        if (separatorIndex > 0) {
            collections.add(icon.slice(0, separatorIndex));
        }
    }
    return collections;
}

function extractInstalledCollections(packageJsonContent: string): Set<string> {
    const parsed = JSON.parse(packageJsonContent) as PackageJson;

    const installed = new Set<string>();
    const dependencyBuckets = [
        parsed.dependencies,
        parsed.devDependencies,
    ];

    for (const dependencies of dependencyBuckets) {
        if (!dependencies) {
            continue;
        }

        for (const packageName of Object.keys(dependencies)) {
            if (!packageName.startsWith('@iconify-json/')) {
                continue;
            }
            installed.add(packageName.slice('@iconify-json/'.length));
        }
    }

    return installed;
}

async function checkTarget(target: IProjectTarget, installedCollections: Set<string>) {
    const configContent = await readFile(target.configPath, 'utf8');
    const bundledIcons = extractBundledIconsFromConfig(configContent);
    const bundledCollections = extractCollections(bundledIcons);
    const collectionHints = createCollectionHints([
        ...installedCollections,
        ...bundledCollections,
    ]);

    const usageByIcon = new Map<string, Set<string>>();

    for (const sourceDirectory of target.sourceDirectories) {
        const sourceFiles = await collectFilesRecursively(sourceDirectory);

        for (const sourceFile of sourceFiles) {
            const sourceContent = await readFile(sourceFile, 'utf8');
            const relativePath = toRelative(sourceFile);
            const extension = path.extname(sourceFile).toLowerCase();

            if (extension === '.vue') {
                collectVueSfcUsages(sourceContent, relativePath, usageByIcon, collectionHints);
                continue;
            }

            collectScriptUsages(sourceContent, relativePath, usageByIcon, collectionHints);
        }
    }

    const usedIcons = uniqueSorted(usageByIcon.keys());
    const missingIcons = usedIcons.filter((icon) => !bundledIcons.has(icon));

    return {
        target,
        missingIcons,
        usageByIcon,
    };
}

async function main() {
    const target = parseTarget();
    const projectTargets = getProjectTargets(target);
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJsonContent = await readFile(packageJsonPath, 'utf8');
    const installedCollections = extractInstalledCollections(packageJsonContent);

    const results = await Promise.all(
        projectTargets.map(projectTarget => checkTarget(projectTarget, installedCollections)),
    );

    const hasMissingIcons = results.some(result => result.missingIcons.length > 0);
    if (hasMissingIcons) {
        console.error('Icon bundle coverage check failed.');

        for (const result of results) {
            if (result.missingIcons.length === 0) {
                continue;
            }

            console.error('');
            console.error(`[${result.target.label}] Missing ${result.missingIcons.length} icon(s) in clientBundle.icons (${toRelative(result.target.configPath)}):`);

            for (const icon of result.missingIcons) {
                const usageFiles = uniqueSorted(result.usageByIcon.get(icon) ?? []);
                const displayFiles = usageFiles.slice(0, 3).join(', ');
                const suffix = usageFiles.length > 3 ? ` (+${usageFiles.length - 3} more)` : '';
                console.error(`- ${icon} (used in: ${displayFiles}${suffix})`);
            }
        }

        process.exit(1);
    }

    console.log(`Icon bundle coverage check passed for ${formatTarget(target)}.`);
}

function isDirectExecution() {
    const entryFilePath = process.argv[1];
    if (!entryFilePath) {
        return false;
    }
    return pathToFileURL(path.resolve(entryFilePath)).href === import.meta.url;
}

if (isDirectExecution()) {
    main().catch((error) => {
        console.error('Failed to check icon bundle coverage:', error);
        process.exit(1);
    });
}
