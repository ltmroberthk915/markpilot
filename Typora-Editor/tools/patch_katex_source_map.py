"""Reproducible, opt-in source-location patch for the vendored KaTeX 0.16.9.

The original bundle is kept in orig-render. The patch only changes HTML metadata
when sourceMap:true is requested; trust settings and TeX parsing stay unchanged.
"""
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELATIVE = Path("cdn/vditor/dist/js/katex/katex.min.js")
ORIGINAL = ROOT / "orig-render" / RELATIVE
TARGET = ROOT / "extension-src/render" / RELATIVE
EXPECTED = "dc84b296ec3e884de093158f760fd9d45b6c7abe58b5381557f4e138f46a58ae"


def build(source):
    def replace(old, new):
        nonlocal source
        assert source.count(old) == 1, f"KaTeX patch anchor changed: {old[:90]}"
        source = source.replace(old, new, 1)

    replace('h={displayMode:', 'h={sourceMap:{type:"boolean",default:!1},displayMode:')
    # Clone macro-body tokens before substitution. Expanded body glyphs map to
    # the invocation, while substituted argument tokens retain their own origins.
    replace(
        'var i=a.tokens,o=this.consumeArgs(a.numArgs,a.delimiters);if(a.numArgs)',
        'var i=a.tokens,o=this.consumeArgs(a.numArgs,a.delimiters);'
        'if(this.settings.sourceMap){var typoraOrigin=t.__typoraOrigin||t.loc;'
        'i=i.map(function(token){var copy=Object.assign(Object.create(Object.getPrototypeOf(token)),token);'
        'copy.__typoraOrigin=typoraOrigin;return copy})}if(a.numArgs)',
    )
    # parseGroup sees the actual source token before parsing its children. This
    # includes function tokens such as \\frac, whose AST node normally has no loc.
    replace(
        'r=this.formatUnsupportedCmd(i),this.consume()}return r},t.formLigatures=',
        'r=this.formatUnsupportedCmd(i),this.consume()}'
        'if(r&&this.settings.sourceMap){var typoraLoc=a.__typoraOrigin||a.loc;'
        'if(typoraLoc&&typoraLoc.lexer===this.gullet.lexer)'
        'r.__typoraSource={start:typoraLoc.start,end:typoraLoc.end}}'
        'return r},t.formLigatures=',
    )
    # The HTML builder attaches locations to the generated node, independently of
    # visual order (fractions and script layout rearrange the DOM).
    replace('return a}throw new n("Got group of unknown type:',
            'typoraMapSource(a,e);return a}throw new n("Got group of unknown type:')
    helper = '''function typoraMapSource(node,group){
      var loc=group.__typoraSource||(group.base&&group.base.__typoraSource);
      if(!loc)return;
      function mark(target){
        if(target instanceof A){target.children.forEach(mark);return}
        target.attributes=target.attributes||{};
        if(target.attributes["data-typora-source-start"]===undefined){
          target.attributes["data-typora-source-start"]=String(loc.start);
          target.attributes["data-typora-source-end"]=String(loc.end);
        }
      }
      mark(node);
    }
    '''
    replace('function kt(e,t){', helper + 'function kt(e,t){')
    # SymbolNode has no generic attributes in upstream KaTeX. Preserve metadata
    # both for renderToString() and render(). Normal, unmapped output is identical.
    replace('var a=l.escape(this.text);return e?',
            'if(this.attributes)for(var typoraKey in this.attributes){e=!0;'
            't+=" "+l.escape(typoraKey)+\'=\"\'+l.escape(this.attributes[typoraKey])+\'\"\'}'
            'var a=l.escape(this.text);return e?')
    replace('return t?(t.appendChild(e),t):e},t.toMarkup=function(){var e=!1,t="<span";',
            'if(this.attributes){t=t||document.createElement("span");'
            'for(var typoraKey in this.attributes)t.setAttribute(typoraKey,this.attributes[typoraKey])}'
            'return t?(t.appendChild(e),t):e},t.toMarkup=function(){var e=!1,t="<span";')
    # Different source tokens must remain independently clickable. Symbols from
    # one macro invocation may still coalesce because their origin is identical.
    replace('r instanceof Z&&n instanceof Z&&Ue(r,n)&&(',
            'r instanceof Z&&n instanceof Z&&Ue(r,n)&&'
            '((!r.attributes&&!n.attributes)||(r.attributes&&n.attributes&&'
            'r.attributes["data-typora-source-start"]===n.attributes["data-typora-source-start"]&&'
            'r.attributes["data-typora-source-end"]===n.attributes["data-typora-source-end"]))&&(')
    return source


if __name__ == "__main__":
    original = ORIGINAL.read_bytes()
    assert sha256(original).hexdigest() == EXPECTED, "Unexpected upstream KaTeX bundle"
    patched = build(original.decode("utf-8"))
    current = TARGET.read_text(encoding="utf-8")
    assert current in (original.decode("utf-8"), patched), "Unrecognized local KaTeX edits; refusing to overwrite"
    TARGET.write_text(patched, encoding="utf-8", newline="")
    print("KaTeX 0.16.9 opt-in source map patch applied")
