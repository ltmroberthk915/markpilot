const {test} = require("node:test");
const assert = require("node:assert/strict");
const katex = require("../extension-src/render/cdn/vditor/dist/js/katex/katex.min.js");
const original = require("../orig-render/cdn/vditor/dist/js/katex/katex.min.js");

const entries = node => {
  const children = (node.children || []).flatMap(entries);
  const start = node.attributes?.["data-typora-source-start"];
  return start === undefined ? children : [{
    start: Number(start), end: Number(node.attributes["data-typora-source-end"]),
    text: node.text, classes: node.classes || [],
  }, ...children];
};
const mapped = (source, options = {}) => entries(katex.__renderToDomTree(source, {
  output: "html", sourceMap: true, ...options,
}));
const sources = [
  String.raw`\frac{a}{b}+a+\Omega`,
  String.raw`\frac{a+\frac{b}{c}}{d}`,
  String.raw`\sqrt[3]{x^2}+\sum_{i=1}^n i`,
  String.raw`\int_0^1 x\,dx+\sin(x)`,
  String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
  String.raw`\left(\frac{x}{y}\right)^2`,
  String.raw`\hat{x}+\vec{y}+\overline{AB}`,
  String.raw`\text{hello world}+\mathbf{abc}+12345`,
  String.raw`\newcommand{\sq}[1]{#1^2}\sq{x}+\sq{y}`,
];

for (const source of sources) {
  test("mapping preserves output when disabled: " + source, () => {
    assert.equal(katex.renderToString(source, {output: "html"}), original.renderToString(source, {output: "html"}));
  });
  test("mapping preserves layout metrics: " + source, () => {
    const before = original.__renderToDomTree(source, {output: "html"});
    const after = katex.__renderToDomTree(source, {output: "html", sourceMap: true});
    assert.equal(after.height, before.height);
    assert.equal(after.depth, before.depth);
    const text = node => (node.text || "") + (node.children || []).map(text).join("");
    assert.equal(text(after), text(before));
    for (const entry of entries(after)) {
      assert(entry.start >= 0 && entry.start < entry.end && entry.end <= source.length);
    }
  });
}
test("fraction children, duplicate characters and Greek commands retain their own offsets", () => {
  const source = String.raw`\frac{a}{b}+a+\Omega`;
  const nodes = mapped(source);
  for (const [text, start] of [["a", 6], ["b", 9], ["a", 12], ["Ω", 14]]) {
    assert(nodes.some(node => node.text === text && node.start === start), text + " at " + start);
  }
  assert(nodes.some(node => node.start === 0 && node.end === 5), "fraction structure maps to \\frac");
});
test("macro expansion maps generated symbols to each invocation", () => {
  const nodes = mapped(String.raw`\RR+\RR`, {macros: {"\\RR": "\\mathbb{R}"}});
  assert(nodes.some(node => node.text === "R" && node.start === 0 && node.end === 3));
  assert(nodes.some(node => node.text === "R" && node.start === 4 && node.end === 7));
});
test("macro arguments retain their source, generated exponents map to the invocation", () => {
  const source = String.raw`\newcommand{\sq}[1]{#1^2}\sq{x}+\sq{y}`;
  const nodes = mapped(source);
  for (const char of ["x", "y"]) {
    assert(nodes.some(node => node.text === char && node.start === source.indexOf(char)));
    const call = source.indexOf("\\sq{" + char);
    assert(nodes.some(node => node.start === call && node.end === call + 3));
  }
});
