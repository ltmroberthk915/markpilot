// Matches the locked markdownLanguage raw parser. The receiver validates
// the complete NodeSet manifest; incompatible data falls back to native.
import { parser, GFM, Subscript, Superscript, Emoji } from '@lezer/markdown';
import { Tree, TreeBuffer, NodeProp } from '@lezer/common';
import { createRawTreeCodec } from './worker-tree-codec.js';
const rawParser = parser.configure([GFM, Subscript, Superscript, Emoji]);
const codec = createRawTreeCodec({ Tree, TreeBuffer, NodeProp });
let text = '', revision = 0, timer;
onmessage = ({ data }) => {
  try {
    if (!Number.isSafeInteger(data.revision) || data.revision <= revision) throw Error('Invalid Markdown revision');
    if (data.type === 'reset') {
      if (typeof data.text !== 'string') throw Error('Invalid Markdown snapshot');
      text = data.text;
    } else if (data.type === 'change') {
      if (data.baseRevision !== revision || !Array.isArray(data.edits)) throw Error('Markdown mirror revision mismatch');
      let previous = 0;
      for (const edit of data.edits) {
        if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < previous || edit.to < edit.from || edit.to > text.length || typeof edit.insert !== 'string') throw Error('Invalid Markdown change');
        previous = edit.to;
      }
      for (let i = data.edits.length - 1; i >= 0; i--) {
        const e = data.edits[i]; text = text.slice(0, e.from) + e.insert + text.slice(e.to);
      }
      if (text.length !== data.length) throw Error('Markdown mirror length mismatch');
    } else throw Error('Invalid Markdown Worker message');
    revision = data.revision; clearTimeout(timer);
    timer = setTimeout(() => {
      try { postMessage({ type: 'tree', revision, length: text.length, wire: codec.encode(rawParser.parse(text), rawParser.nodeSet) }); }
      catch (error) { postMessage({ type: 'error', revision, error: error.message }); }
    }, 75);
  } catch (error) { postMessage({ type: 'error', revision: data.revision, error: error.message }); }
};
