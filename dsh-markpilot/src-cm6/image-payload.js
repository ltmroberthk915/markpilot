import { EditorState, StateField, Prec } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

// Recognition belongs to the existing image producer, including code exclusions.
export const isEmbeddedImage = region => !!region?.payload && /^data:image\//i.test(region.data?.image?.src || '');
export const embeddedImages = (state, indexField) => (state.field(indexField).byKind.get('image') || []).filter(isEmbeddedImage);

export class ProtectedImagePayloadWidget extends WidgetType {
  constructor(region) {
    super(); this.id = region.id; this.length = region.payload[1] - region.payload[0];
    const type = /^data:image\/(png|jpeg|jpg|gif|svg\+xml|webp|bmp|avif|x-icon|tiff)(?=[;,])/i.exec(region.data.image.src)?.[1];
    this.label = type ? '内嵌 ' + type.replace(/\+xml$/i, '').toUpperCase() + ' 图片' : '内嵌图片';
  }
  eq(other) { return other.id === this.id && other.length === this.length && other.label === this.label; }
  toDOM() {
    const chip = document.createElement('span');
    chip.className = 'mp-image-payload mp-image-payload-protected';
    chip.contentEditable = 'false';
    chip.textContent = this.label;
    chip.title = '图片内容已保护，可通过图片菜单替换';
    chip.setAttribute('role', 'img'); chip.setAttribute('aria-label', this.label);
    chip.addEventListener('mousedown', event => event.preventDefault());
    return chip;
  }
  ignoreEvent() { return true; }
}

export function protectedPayloadDecoration(region) {
  return Decoration.replace({ widget: new ProtectedImagePayloadWidget(region) }).range(...region.payload);
}

// The source view receives the already parsed master ranges in the same mirror
// update as its document. It has no parser, history or independent writable state.
export function createImagePayloadProjection(readRegions) {
  const project = () => Decoration.set(readRegions().map(protectedPayloadDecoration), true);
  const field = StateField.define({
    create: project,
    update(value, transaction) { return transaction.docChanged ? project() : value; },
    provide: field => [EditorView.decorations.from(field), EditorView.atomicRanges.of(view => view.state.field(field))],
  });
  return field;
}

export function safeImagePayloadPosition(regions, position) {
  const region = regions.find(region => position >= region.payload[0] && position <= region.payload[1]);
  if (!region) return position;
  return region.editFrom < region.payload[0] || region.editFrom > region.payload[1] ? region.editFrom : region.from;
}

export function protectImagePayloads(indexField, beforeChange = transaction => transaction, bypass = () => false) {
  // Filters execute in reverse precedence order: inspect the final rewritten
  // change, after table/input filters. A forbidden member rejects the whole edit.
  return Prec.highest(EditorState.transactionFilter.of(transaction => {
    if (!transaction.docChanged || bypass() || transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) return transaction;
    const regions = embeddedImages(transaction.startState, indexField);
    if (!regions.length) return beforeChange(transaction);
    const replaced = new Set(); let forbidden = false;
    transaction.changes.iterChangedRanges((from, to) => {
      for (const region of regions) {
        if (from <= region.from && to >= region.to) { replaced.add(region); continue; }
        const [start, end] = region.payload;
        if (from === to ? from >= start && from <= end : from < end && to > start) forbidden = true;
      }
    });
    if (forbidden) return [];
    // Deleting image syntax must not turn unchanged attachment bytes into text.
    // This also covers an enclosing fence/comment edited before an image.
    const surviving = new Map(embeddedImages(transaction.state, indexField).map(region => [region.payload.join(':'), region]));
    for (const region of regions) {
      if (replaced.has(region)) continue;
      const range = [transaction.changes.mapPos(region.payload[0], 1), transaction.changes.mapPos(region.payload[1], -1)];
      if (surviving.get(range.join(':'))?.data.image.src !== region.data.image.src) return [];
    }
    return beforeChange(transaction);
  }));
}
