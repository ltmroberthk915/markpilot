import { ViewPlugin } from '@codemirror/view';

// Result/inflight caches are content keyed. Mounts are consumer keyed and tied
// to the current document, region, context, and content revision.
export function createRenderLifecycle(indexField) {
  const views = new WeakMap(), nodes = new WeakMap();
  const record = view => {
    let value = views.get(view);
    if (!value) { value = { mounts: new Set(), images: new Map(), disposed: false }; views.set(view, value); }
    return value;
  };
  const release = node => {
    const lease = nodes.get(node);
    if (!lease) return;
    lease.disposed = true;
    for (const fn of lease.cleanups) { try { fn(); } catch { } }
    lease.cleanups.clear(); lease.record.mounts.delete(lease); nodes.delete(node);
  };
  function mount(view, region, node, { sameContent = null } = {}) {
    release(node);
    const owner = record(view), epoch = view.state.field(indexField).epoch;
    const lease = { record: owner, disposed: false, cleanups: new Set(), node, id: region?.id, epoch,
      revision: region?.revision, contextVersion: region?.contextVersion, sameContent,
      accepts(current) { return current.revision === this.revision || !!this.sameContent?.(current); },
      valid(connected = true) {
        if (owner.disposed || this.disposed || nodes.get(node) !== this) return false;
        const index = view.state.field(indexField, false), current = index?.byId.get(this.id);
        return index?.epoch === epoch && !!current && this.accepts(current) &&
          current.contextVersion === this.contextVersion && (!connected || (node.isConnected && view.dom.contains(node)));
      },
      publish(fn) { if (!this.valid()) return false; fn(); view.requestMeasure(); return true; },
      cleanup(fn) { this.cleanups.add(fn); },
    };
    nodes.set(node, lease); owner.mounts.add(lease);
    return lease;
  }
  const extension = ViewPlugin.fromClass(class {
    constructor(view) { this.view = view; this.owner = record(view); this.epoch = view.state.field(indexField).epoch; }
    update(u) {
      const index = u.state.field(indexField);
      if (index.epoch !== this.epoch) {
        for (const lease of [...this.owner.mounts]) release(lease.node);
        this.owner.images.clear(); this.epoch = index.epoch;
      } else {
        for (const [id] of this.owner.images) if (!index.byId.has(id)) this.owner.images.delete(id);
        for (const lease of [...this.owner.mounts]) {
          const r = index.byId.get(lease.id);
          if (!r || r.contextVersion !== lease.contextVersion || !lease.accepts(r)) release(lease.node);
          else lease.revision = r.revision;
        }
      }
    }
    destroy() {
      this.owner.disposed = true;
      for (const lease of [...this.owner.mounts]) release(lease.node);
      this.owner.images.clear(); views.delete(this.view);
    }
  });
  return { extension, mount, release,
    image(view, id, src) { const hit = record(view).images.get(id); return hit?.src === src && hit.node.complete && hit.node.naturalWidth ? hit.node : null; },
    rememberImage(view, id, src, node) { if (view.state.field(indexField).byId.has(id)) record(view).images.set(id, { src, node }); },
    inspect(view) { const r = record(view); return { mounts: r.mounts.size, decodedImages: r.images.size, disposed: r.disposed }; },
  };
}
