// Raw-tree wire format shared by the renderer and its dedicated Worker.
// Pass the exact Tree / TreeBuffer / NodeProp classes from the caller's bundle.
export function createRawTreeCodec({ Tree, TreeBuffer, NodeProp }) {
  const schema = "mp-lezer-raw-v1";
  const namedProps = [
    ["contextHash", NodeProp.contextHash],
    ["lookAhead", NodeProp.lookAhead],
  ];
  const propByName = new Map(namedProps);
  const nameById = new Map(namedProps.map(([name, prop]) => [prop.id, name]));
  const check = (ok, message) => { if (!ok) throw new RangeError(message); };
  const integer = (n) => Number.isSafeInteger(n) && n >= 0;

  function manifest(nodeSet) {
    return nodeSet.types.map((type) => [
      type.id, type.name, type.isTop, type.isError, type.isAnonymous,
    ]);
  }

  function encodeNode(node, nodeSet) {
    if (node instanceof TreeBuffer) {
      check(node.set === nodeSet, "Raw TreeBuffer belongs to a different NodeSet");
      return { k: "b", l: node.length, b: node.buffer.slice() };
    }
    check(node instanceof Tree, "Expected a genuine Tree or TreeBuffer");
    check(nodeSet.types[node.type.id] === node.type, "Raw Tree type is absent from NodeSet");
    const props = node.propValues.map(([prop, value]) => {
      const id = typeof prop === "number" ? prop : prop.id;
      const name = nameById.get(id);
      check(!!name, "Unsupported raw per-node property " + id + "; mixed/stopped trees are not raw");
      check(typeof value === "number" && Number.isFinite(value), "Invalid numeric property " + name);
      return [name, value];
    });
    return {
      k: "t", i: node.type.id, l: node.length,
      p: Array.from(node.positions), v: props,
      c: node.children.map((child) => encodeNode(child, nodeSet)),
    };
  }

  function encode(tree, nodeSet) {
    return { schema, types: manifest(nodeSet), root: encodeNode(tree, nodeSet) };
  }

  function decodeNode(node, nodeSet) {
    check(node && integer(node.l), "Invalid raw node length");
    if (node.k === "b") {
      check(node.b instanceof Uint16Array && node.b.length % 4 === 0, "Invalid TreeBuffer payload");
      for (let i = 0; i < node.b.length; i += 4) {
        const id = node.b[i], from = node.b[i + 1], to = node.b[i + 2], end = node.b[i + 3];
        check(!!nodeSet.types[id], "Unknown TreeBuffer type ID");
        check(from <= to && to <= node.l && end >= i + 4 && end <= node.b.length && end % 4 === 0, "Invalid TreeBuffer record");
      }
      // Independent typed data, plus independent Tree nodes, for every decode.
      return new TreeBuffer(node.b.slice(), node.l, nodeSet);
    }
    check(node.k === "t" && integer(node.i) && !!nodeSet.types[node.i], "Invalid Tree type ID");
    check(Array.isArray(node.c) && Array.isArray(node.p) && node.c.length === node.p.length, "Invalid child positions");
    check(Array.isArray(node.v), "Invalid raw properties");
    const children = node.c.map((child) => decodeNode(child, nodeSet));
    const positions = node.p.map((pos, i) => {
      check(integer(pos) && pos + children[i].length <= node.l, "Child exceeds raw node length");
      return pos;
    });
    const seen = new Set();
    const props = node.v.map(([name, value]) => {
      check(propByName.has(name) && !seen.has(name), "Unknown or duplicate raw property");
      check(typeof value === "number" && Number.isFinite(value), "Invalid raw property value");
      seen.add(name);
      return [propByName.get(name), value];
    });
    return new Tree(nodeSet.types[node.i], children, positions, node.l, props);
  }

  function decode(wire, nodeSet) {
    check(wire && wire.schema === schema, "Unknown raw tree schema");
    check(JSON.stringify(wire.types) === JSON.stringify(manifest(nodeSet)), "NodeSet type manifest mismatch");
    return decodeNode(wire.root, nodeSet);
  }

  return { schema, manifest, encode, decode };
}

// The enclosing wrapper must use this only for ranges [0,input.length].
// A full cached tree may extend beyond stopAt, as the public PartialParse
// contract allows. Outer MixedParse decides which sublanguages to parse.
export function createReadyPartial({ wire, nodeSet, codec, inputLength }) {
  let stoppedAt = null, tree = null, parsedPos = 0;
  return {
    get stoppedAt() { return stoppedAt; },
    get parsedPos() { return parsedPos; },
    stopAt(pos) {
      if (!Number.isFinite(pos)) throw new RangeError("Invalid stop position");
      if (stoppedAt !== null && pos > stoppedAt) throw new RangeError("Can't move stoppedAt forward");
      stoppedAt = pos;
    },
    advance() {
      if (!tree) {
        tree = codec.decode(wire, nodeSet);
        if (tree.length !== inputLength) throw new RangeError("Raw tree length does not match input");
        parsedPos = inputLength;
      }
      return tree;
    },
  };
}

