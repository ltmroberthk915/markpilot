'use strict';
// Maintained KaTeX sourceMap port. Reads the pinned package and generates the verified private build cache.
// No renderer execution, deletion, or network. The builder publishes this cache.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, "../..");
const BASE = path.join(ROOT, ".mp-verify/vendor-katex-source-map");
const INPUT = path.join(ROOT, 'dsh-markpilot/node_modules/katex');
const UPSTREAM = path.join(BASE, 'upstream');
const PATCHED = path.join(BASE, 'patched');
const VERSION = '0.19.0';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pins = {
  'package.json': '279db0fd6fcecf3fe3da1c1244dc9387e527b877d23638be6cf0c5e2a03817ea',
  'katex.ts': '6c33f01edc0e85988810f46d974374a312f66c11f8f8c090aaea4e6ce0e332d2',
  'LICENSE': '766ccc1f306c885aa45542a9846bbd0a505b27a0374f146778171c2254ce18e3',
  'src/Settings.ts': 'a3b04291805997c2a7f0c7600f78034b4ea79783ce2f238e5ca81ef52265acb1',
  'src/Token.ts': 'ca3910b6cf424805e01ec08f8572c79013b06cc33efd4fc5deb0157a057300e7',
  'src/types/nodes.ts': '2d8e80efa0ed566e58a9c793e8338e09e51cc3ac7f280c11919009876c5493e4',
  'src/MacroExpander.ts': 'dca51df6efae6c4f958c2313d566910f4857db7e4930c216c88de6cb3aeb4b27',
  'src/Parser.ts': 'c1aed05097bb0c429b7e1b5fe0862a7db515bd1682b014d6775edeb2e8da0e6a',
  'src/buildHTML.ts': '9b22eee0850fe5fd5cc3bcd5623e11bebcd3d5fe71b66f36e601c7a0f1ece27f',
  'src/domTree.ts': '8bfeab3612a83098133013e85fe2da0ea245b8c87aef9f990879ffc8e89df6eb',
  'src/buildCommon.ts': '0cae9bd3b1dd21b536e8c9a96f11838c87bcbaceaca89927c03b46750a4fba73',
  'src/unicodeAccents.js': 'f3c3358ad79c0cc26a96f2741bfbe0e494ba4f075a0fb400758dc204097a3c55',
  'src/unicodeSymbols.js': '9c16656286cc5575a3e250b6e47c900802a24fe0a59c1cb0e3bb5c5d51f1f27e',
};
const operations = [];
const byFile = (a,b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
const fileContents = new Map();
const inputFiles = [];
const getPath = (base, relative) => {
  const value = path.resolve(base, relative);
  if (!value.startsWith(path.resolve(base) + path.sep)) throw Error('Path escapes private target: ' + relative);
  return value;
};
const write = (base, relative, value) => {
  const target = getPath(base, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
};
for (const [relative, hash] of Object.entries(pins)) {
  const bytes = fs.readFileSync(getPath(INPUT, relative));
  if (sha(bytes) !== hash) throw Error('Upstream SHA256 mismatch: ' + relative);
}
if (JSON.parse(fs.readFileSync(path.join(INPUT, 'package.json'), 'utf8')).version !== VERSION) {
  throw Error('Wrong upstream package version');
}
function collect(relative) {
  const file = getPath(INPUT, relative), stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw Error('Symlink not allowed in input: ' + relative);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(file).sort()) collect(relative + '/' + name);
  } else {
    const bytes = fs.readFileSync(file);
    inputFiles.push({ file: relative, sha256: sha(bytes), bytes: bytes.length });
    fileContents.set(relative, bytes);
  }
}
for (const item of ['src', 'katex.ts', 'package.json', 'LICENSE', 'dist/katex.min.css', 'dist/fonts', 'dist/contrib/mhchem.min.js']) collect(item);
// All 176 inputs were checked against the npm tarball's locked SHA512. Pin the
// entire membership and byte inventory, including modules untouched by hooks.
const inputInventory = JSON.stringify(inputFiles.sort(byFile));
if (sha(inputInventory) !== '7fedfe7be9688a5e6f2c8192908f2e364a6b0975f520c3346dba080849b29516') {
  throw Error('Pinned upstream inventory mismatch');
}
function source(file) { return fileContents.get(file).toString('utf8').replace(/\r\n/g, '\n'); }
const modified = new Map();
function replaceOnce(file, id, old, next) {
  if (operations.some(op => op.id === id)) throw Error('Duplicate patch ID: ' + id);
  const text = modified.has(file) ? modified.get(file) : source(file);
  const count = text.split(old).length - 1;
  if (!old || count !== 1) throw Error(`${id}: expected exactly one source anchor, found ${count}`);
  const index = text.indexOf(old);
  modified.set(file, text.slice(0, index) + next + text.slice(index + old.length));
  operations.push({ file, id, old, next });
}

replaceOnce('src/Settings.ts', 'setting-schema',
  'export const SETTINGS_SCHEMA: Schema = {\n    displayMode:',
  'export const SETTINGS_SCHEMA: Schema = {\n    sourceMap: { type: "boolean", default: false },\n    displayMode:');
replaceOnce('src/Settings.ts', 'setting-field',
  'export default class Settings {\n    displayMode!: boolean;',
  'export default class Settings {\n    sourceMap!: boolean;\n    displayMode!: boolean;');
replaceOnce('src/Token.ts', 'token-origin-type',
  '    loc: SourceLocation | null | undefined;\n    noexpand:',
  '    loc: SourceLocation | null | undefined;\n    __typoraOrigin?: SourceLocation | null;\n    noexpand:');
replaceOnce('src/types/nodes.ts', 'node-source-import',
  'import type SourceLocation from "../SourceLocation";',
  'import type SourceLocation from "../SourceLocation";\nimport type {TyporaSourceRange} from "../typoraSource";');
replaceOnce('src/types/nodes.ts', 'node-source-type',
  'type BaseNode = {\n    mode: Mode;\n    loc?: SourceLocation | null;\n};',
  'type BaseNode = {\n    mode: Mode;\n    loc?: SourceLocation | null;\n    __typoraSource?: TyporaSourceRange;\n};');

replaceOnce('src/MacroExpander.ts', 'macro-origin-import',
  'import {Token}', 'import {typoraOriginOf} from "./typoraSource";\nimport {Token}');
replaceOnce('src/MacroExpander.ts', 'macro-body-origin', String.raw`        let tokens = expansion.tokens;
        const args = this.consumeArgs(expansion.numArgs, expansion.delimiters);
        if (expansion.numArgs) {`, String.raw`        let tokens = expansion.tokens;
        const args = this.consumeArgs(expansion.numArgs, expansion.delimiters);
        if (this.settings.sourceMap) {
            const origin = typoraOriginOf(topToken);
            tokens = tokens.map(token => {
                const copy = Object.assign(
                    Object.create(Object.getPrototypeOf(token)), token) as Token;
                copy.__typoraOrigin = origin;
                return copy;
            });
        }
        if (expansion.numArgs) {`);

replaceOnce('src/Parser.ts', 'parser-origin-import',
  'import type {AnyParseNode, NodeType, ParseNode, SymbolParseNode, UnsupportedCmdParseNode} from "./types/nodes";',
  'import type {AnyParseNode, NodeType, ParseNode, SymbolParseNode, UnsupportedCmdParseNode} from "./types/nodes";\nimport {typoraSourceOf, joinTyporaSources, typoraMappedToken} from "./typoraSource";');
replaceOnce('src/Parser.ts', 'parser-result-type',
  '        let result;\n        // Try to parse an open brace',
  '        let result: AnyParseNode | null;\n        // Try to parse an open brace');
replaceOnce('src/Parser.ts', 'parser-group-origin', String.raw`        }
        return result;
    }

    /**
     * Form ligature-like combinations`, String.raw`        }
        if (result && this.settings.sourceMap) {
            const source = typoraSourceOf(firstToken, this.gullet.lexer);
            if (source) result.__typoraSource = source;
        }
        return result;
    }

    /**
     * Form ligature-like combinations`);
replaceOnce('src/Parser.ts', 'ligature-three-source',
  '                        loc: SourceLocation.range(a, afterNext),\n                        text: "---",',
  '                        loc: SourceLocation.range(a, afterNext),\n                        __typoraSource: joinTyporaSources(a.__typoraSource, afterNext.__typoraSource),\n                        text: "---",');
replaceOnce('src/Parser.ts', 'ligature-two-source',
  '                        loc: SourceLocation.range(a, next),\n                        text: "--",',
  '                        loc: SourceLocation.range(a, next),\n                        __typoraSource: joinTyporaSources(a.__typoraSource, next.__typoraSource),\n                        text: "--",');
replaceOnce('src/Parser.ts', 'ligature-quotes-source',
  '                    loc: SourceLocation.range(a, next),\n                    text: v + v,',
  '                    loc: SourceLocation.range(a, next),\n                    __typoraSource: joinTyporaSources(a.__typoraSource, next.__typoraSource),\n                    text: v + v,');
replaceOnce('src/Parser.ts', 'unicode-first-origin',
  '                subsupTokens.push(new Token(uSubsAndSups[lex.text]));',
  '                subsupTokens.push(typoraMappedToken(uSubsAndSups[lex.text], lex, this.settings.sourceMap));');
replaceOnce('src/Parser.ts', 'unicode-next-origin', String.raw`                    const token = this.fetch().text;
                    if (!(uSubsAndSups[token])) { break; }
                    if (unicodeSubRegEx.test(token) !== isSub) { break; }
                    subsupTokens.unshift(new Token(uSubsAndSups[token]));`, String.raw`                    const sourceToken = this.fetch();
                    const token = sourceToken.text;
                    if (!(uSubsAndSups[token])) { break; }
                    if (unicodeSubRegEx.test(token) !== isSub) { break; }
                    subsupTokens.unshift(typoraMappedToken(uSubsAndSups[token], sourceToken, this.settings.sourceMap));`);
replaceOnce('src/Parser.ts', 'prime-first-source',
  '                const prime: ParseNode<"textord"> = {type: "textord", mode: this.mode, text: "\\\\prime"};',
  '                const prime: ParseNode<"textord"> = {type: "textord", mode: this.mode, text: "\\\\prime",\n                    __typoraSource: this.settings.sourceMap ? typoraSourceOf(lex, this.gullet.lexer) : undefined};');
replaceOnce('src/Parser.ts', 'prime-next-source', String.raw`                while (this.fetch().text === "'") {
                    // For each one, add another prime to the list
                    primes.push(prime);
                    this.consume();`, String.raw`                while (this.fetch().text === "'") {
                    // For each one, add another prime to the list
                    primes.push(this.settings.sourceMap ? {...prime,
                        __typoraSource: typoraSourceOf(this.fetch(), this.gullet.lexer)} : prime);
                    this.consume();`);

replaceOnce('src/buildHTML.ts', 'html-group-source',
  '        return groupNode;\n    } else {\n        throw new ParseError(',
  '        typoraMapSource(groupNode, group);\n        return groupNode;\n    } else {\n        throw new ParseError(');
replaceOnce('src/buildHTML.ts', 'html-source-helper',
  '/**\n * Combine an array of HTML DOM nodes (e.g., the output of `buildExpression`)',
  String.raw`// Mapping is developer-owned data; it never enables trusted HTML commands.
function typoraMapSource(node: HtmlDomNode, group: AnyParseNode): void {
    const own = (value: object, key: PropertyKey) =>
        Object.prototype.hasOwnProperty.call(value, key);
    const base = own(group, "base") && "base" in group ? group.base : null;
    const direct = own(group, "__typoraSource") ? group.__typoraSource : undefined;
    const loc = direct ?? (base && own(base, "__typoraSource") ? base.__typoraSource : undefined);
    if (!loc) return;
    const mark = (current: HtmlDomNode): void => {
        if (current instanceof DocumentFragment) {
            current.children.forEach(mark);
            return;
        }
        const target = current as HtmlDomNode & {attributes?: Record<string, string>};
        const attrs = target.attributes ?? (target.attributes = Object.create(null));
        if (!own(attrs, "data-typora-source-start")) {
            Object.defineProperty(attrs, "data-typora-source-start", {
                value: String(loc.start), enumerable: true, writable: true, configurable: true,
            });
            Object.defineProperty(attrs, "data-typora-source-end", {
                value: String(loc.end), enumerable: true, writable: true, configurable: true,
            });
        }
    };
    mark(node);
}

` + '/**\n * Combine an array of HTML DOM nodes (e.g., the output of `buildExpression`)');

replaceOnce('src/domTree.ts', 'symbol-attribute-field',
  'export class SymbolNode implements HtmlDomNode {\n    text: string;',
  'export class SymbolNode implements HtmlDomNode {\n    attributes: Record<string, string>;\n    text: string;');
replaceOnce('src/domTree.ts', 'symbol-attribute-init', String.raw`        this.classes = classes || [];
        this.style = style || {};
        this.maxFontSize = 0;`, String.raw`        this.classes = classes || [];
        this.style = style || {};
        this.attributes = Object.create(null);
        this.maxFontSize = 0;`);
replaceOnce('src/domTree.ts', 'symbol-dom-attributes', String.raw`        if (span) {
            span.appendChild(node);
            return span;`, String.raw`        for (const key of Object.keys(this.attributes)) {
            span = span || document.createElement("span");
            span.setAttribute(key, this.attributes[key]);
        }

        if (span) {
            span.appendChild(node);
            return span;`);
replaceOnce('src/domTree.ts', 'symbol-string-attributes', String.raw`        const escaped = escape(this.text);
        if (needsSpan) {`, String.raw`        for (const key of Object.keys(this.attributes)) {
            needsSpan = true;
            markup += " " + escape(key) + "=\"" + escape(this.attributes[key]) + "\"";
        }

        const escaped = escape(this.text);
        if (needsSpan) {`);
replaceOnce('src/buildCommon.ts', 'symbol-merge-source-barrier',
  'const canCombine = (prev: SymbolNode, next: SymbolNode) => {\n    if (createClass(prev.classes)',
  String.raw`const canCombine = (prev: SymbolNode, next: SymbolNode) => {
    const before = Object.keys(prev.attributes), after = Object.keys(next.attributes);
    if (before.length !== after.length || before.some(key =>
            !Object.prototype.hasOwnProperty.call(next.attributes, key) ||
            prev.attributes[key] !== next.attributes[key])) return false;
    if (createClass(prev.classes)`);

const helper = String.raw`import {Token} from "./Token";
import type {LexerInterface} from "./Token";
import type SourceLocation from "./SourceLocation";

export type TyporaSourceRange = {start: number; end: number};

// Origin belongs to the caller's lexical input, never a macro definition's lexer.
export function typoraOriginOf(token: Token): SourceLocation | null | undefined {
    return Object.prototype.hasOwnProperty.call(token, "__typoraOrigin")
        ? token.__typoraOrigin ?? token.loc : token.loc;
}

export function typoraSourceOf(token: Token, lexer: LexerInterface): TyporaSourceRange | undefined {
    const loc = typoraOriginOf(token);
    if (!loc || loc.lexer !== lexer || !Number.isSafeInteger(loc.start) ||
            !Number.isSafeInteger(loc.end) || loc.start < 0 ||
            loc.end < loc.start || loc.end > lexer.input.length) return undefined;
    return {start: loc.start, end: loc.end};
}

export function joinTyporaSources(first?: TyporaSourceRange, last?: TyporaSourceRange): TyporaSourceRange | undefined {
    // Nonmonotonic expansion cannot claim a contiguous literal range.
    if (!first || !last || last.start < first.start || last.end < first.end) return undefined;
    return {start: first.start, end: last.end};
}

export function typoraMappedToken(text: string, original: Token, enabled: boolean): Token {
    const token = new Token(text);
    if (enabled) token.__typoraOrigin = typoraOriginOf(original);
    return token;
}
`;
modified.set('src/typoraSource.ts', helper);

// Security-sensitive code is neither replaced nor reset by these mapping hooks.
function requireUnchanged(file, id, start, end) {
  const before = source(file), after = modified.get(file) ?? before;
  const take = text => {
    if (text.split(start).length !== 2 || text.split(end).length !== 2) throw Error(id + ': security anchor not unique');
    const a = text.indexOf(start), b = text.indexOf(end, a);
    if (b < a) throw Error(id + ': security range reversed');
    return text.slice(a, b);
  };
  if (take(before) !== take(after)) throw Error('Security code changed: ' + id);
  return { file, id, sha256: sha(take(before)) };
}
const securityGuards = [
  requireUnchanged('src/Settings.ts', 'own-property-setting-processing', 'function getDefaultValue<K', '/**\n * The main Settings object'),
  requireUnchanged('src/MacroExpander.ts', 'edef-output-expansion-count', '    expandTokens(tokens: Token[]): Token[] {', '    expandMacroAsText(name: string)'),
  requireUnchanged('src/Parser.ts', 'shared-gullet-subparse', '    subparse(tokens: Token[]): AnyParseNode[] {', '    static endOfExpression: Set<string>'),
];
for (const marker of ['this.countExpansion(1);', 'this.countExpansion(output.length);']) {
  if (!(modified.get('src/MacroExpander.ts') || '').includes(marker)) throw Error('Lost expansion guard: ' + marker);
}
for (const [relative, bytes] of fileContents) {
  write(UPSTREAM, relative, bytes);
  write(PATCHED, relative, modified.has(relative) ? modified.get(relative) : bytes);
}
write(PATCHED, 'src/typoraSource.ts', helper);
write(BASE, 'LICENSE', fileContents.get('LICENSE'));
const entry = String.raw`// Maintained build entry. The builder must define __VERSION__ as "0.19.0".
import katex from "./patched/katex";
export * from "./patched/katex";
export default katex;
(globalThis as typeof globalThis & {katex: typeof katex}).katex = katex;
`;
write(BASE, 'entry.ts', entry);
write(BASE, 'patches.json', JSON.stringify(operations, null, 2) + '\n');
const outputs = [...fileContents.keys(), 'src/typoraSource.ts'].sort().map(file => {
  const bytes = fs.readFileSync(getPath(PATCHED, file));
  return { file, sha256: sha(bytes), bytes: bytes.length };
});
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'dsh-markpilot/package-lock.json'), 'utf8')).packages['node_modules/katex'];
if (lock.version !== VERSION || lock.resolved !== 'https://registry.npmjs.org/katex/-/katex-0.19.0.tgz' ||
    lock.integrity !== 'sha512-v6Tznz3zJ7u3niRCoDTsumM2+HA2XXcCu+WAacCeHD2z3p9A9Ks987o5FzfTGBN0e8A0vjEgIDvLbICrXpdw/Q==') {
  throw Error('Pinned package-lock identity mismatch');
}
const inventoryText = JSON.stringify({ inputs: inputFiles.sort(byFile), outputs }, null, 2) + '\n';
write(BASE, 'inventory.json', inventoryText);
const manifest = {
  schema: 1, purpose: 'katex-source-map-maintained', upstreamVersion: VERSION,
  upstreamResolved: lock.resolved, upstreamIntegrity: lock.integrity,
  originalVendorSha256: 'f118f3355603ee46e0bb949eefa883d15bdae86730b663c349dfe0059ad18e8b',
  pins, patchCount: operations.length, modifiedFiles: [...modified.keys()].sort(), securityGuards,
  inputFileCount: inputFiles.length, outputFileCount: outputs.length,
  inventory: { file: 'inventory.json', sha256: sha(inventoryText) },
  modifiedOutputs: outputs.filter(item => modified.has(item.file)),
  entrySha256: sha(entry), generatorSha256: sha(fs.readFileSync(__filename)),
  builderSha256: sha(fs.readFileSync(path.join(__dirname, 'build-katex.cjs'))),
  build: { entry: 'entry.ts', bundle: true, format: 'iife', define: {__VERSION__: JSON.stringify(VERSION)},
    legalComments: 'inline', target: 'es2020' },
  stage: 'generated-source',
};
write(BASE, 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(JSON.stringify({ generated: true, patchCount: operations.length,
  modifiedFiles: manifest.modifiedFiles, inputFiles: inputFiles.length, outputFiles: outputs.length,
  securityGuards: securityGuards.map(g => g.id), built: false, tested: false }) + '\n');
