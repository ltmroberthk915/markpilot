const ours = new WeakSet();
export function isOwnAttachmentDefinition(definition) {
  return ours.has(definition);
}
const rechecks = new WeakMap();
const IMAGE_WORDS = ['图', '图片', '截图', '图像', '照片', 'image', 'picture', 'screenshot'];
const AGAIN_WORDS = ['再看', '重新看', '再次看', '再查', '重新查', '再核对', '重新核对', '再看一次', 'again', 're-read', 'reread', 're-check', 'recheck', 're-inspect', 'reinspect'];

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function isOwn(session, seq) {
  if (typeof session?.isOwnSeq !== 'function') return false;
  try {
    return session.isOwnSeq(seq) === true;
  } catch {
    return false;
  }
}

function imageBlock(message, attachmentId) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  for (const block of blocks) {
    if (block?.type === 'image' && block.attachment?.attachmentId === attachmentId) return block;
  }
  return undefined;
}

function canRecheck(session, latest, attachmentId) {
  const text = textOf(latest?.message).toLowerCase();
  if (!IMAGE_WORDS.some((word) => text.includes(word))) return false;
  if (!AGAIN_WORDS.some((word) => text.includes(word))) return false;
  const seen = rechecks.get(session);
  return !(seen && seen.seq === latest?.seq && seen.ids.has(attachmentId));
}

function consumeRecheck(session, latest, attachmentId) {
  const seen = rechecks.get(session);
  const next = seen && seen.seq === latest?.seq ? seen : { seq: latest?.seq, ids: new Set() };
  next.ids.add(attachmentId);
  rechecks.set(session, next);
}

function findAttachment(session, attachmentId, wantedSeq) {
  if (typeof session?.isOwnSeq !== 'function' || typeof session.deriveEventMessage !== 'function') return undefined;
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  let latest;
  let active;
  let offloaded;
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index];
    if (!Number.isInteger(seq) || !isOwn(session, seq)) continue;
    const event = session.eventAt?.(seq);
    if (event?.type !== 'user/message') continue;
    if (event.data?.source?.kind !== 'user') continue;
    let message;
    try {
      message = session.deriveEventMessage(event);
    } catch {
      message = undefined;
    }
    if (!latest) latest = { seq, message };
    if (!message || typeof message !== 'object') continue;
    if (wantedSeq !== undefined && seq !== wantedSeq) continue;
    const block = imageBlock(message, attachmentId);
    if (!block) continue;
    if (block.offloaded === true) {
      if (!offloaded) offloaded = { block, latest };
    } else {
      active = { block, latest };
      break;
    }
  }
  if (active) return { ref: active.block.attachment, latest: active.latest, attachmentId, recheck: false };
  if (!offloaded) return undefined;
  if (!canRecheck(session, offloaded.latest, attachmentId)) return undefined;
  return { ref: offloaded.block.attachment, latest: offloaded.latest, attachmentId, recheck: true };
}

function assertLive(exec) {
  if (exec?.signal?.aborted === true) throw new Error('aborted');
}

async function assertImageModel(exec, getLlm) {
  let routed;
  try {
    routed = exec?.agent?.session?.requestHeader?.()?.config;
  } catch {
    routed = undefined;
  }
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  if (provider === undefined || model === undefined) {
    throw new Error('cannot resolve the current model route for image input');
  }
  const llm = getLlm();
  if (!llm || typeof llm.resolveModelInfo !== 'function') {
    throw new Error('the llm service is unavailable');
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal);
  if (!Array.isArray(active?.inputModalities) || !active.inputModalities.includes('image')) {
    throw new Error('the selected model does not accept image input');
  }
}

function createSpec(getAttachments, getLlm) {
  return {
    name: 'attachment_read_image',
    description: 'Return the original image block attached by a real user in this session. Only accepts attachmentId and optional seq; it never reads files, other sessions, or tool images.',
    parameters: {
      attachmentId: { type: 'string', required: true, description: 'Attachment id from a native user image block.' },
      seq: { type: 'number', description: 'Optional user/message event seq carrying the image.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          image: { type: 'object' },
        },
      },
      render: (_args, value) => [{ type: 'image', attachment: value.image }],
    },
    async execute(args, exec) {
      const attachmentId = typeof args?.attachmentId === 'string' ? args.attachmentId.trim() : '';
      if (!attachmentId) throw new Error('attachmentId must be a non-empty string');
      const session = exec?.agent?.session;
      if (!session) throw new Error('attachment_read_image requires an agent session');
      assertLive(exec);
      await assertImageModel(exec, getLlm);
      const attachments = getAttachments();
      if (!attachments || typeof attachments.readImage !== 'function') throw new Error('no attachment service is mounted');
      const found = findAttachment(session, attachmentId, Number.isInteger(args?.seq) ? args.seq : undefined);
      if (!found) throw new Error('no native image with this attachmentId is visible from a real user message in this session');
      const limits = attachments.imageLimits;
      if (limits && Number.isFinite(found.ref?.bytes)) {
        if (limits.maxImageBytes && found.ref.bytes > limits.maxImageBytes) throw new Error('image exceeds the deployment image byte limit');
        if (limits.maxMessageImageBytes && found.ref.bytes > limits.maxMessageImageBytes) throw new Error('image exceeds the deployment message image limit');
      }
      assertLive(exec);
      const image = await attachments.readImage(found.ref, exec.signal);
      if (!image) throw new Error('the attachment service returned no image');
      assertLive(exec);
      if (found.recheck) consumeRecheck(session, found.latest, found.attachmentId);
      return { image: found.ref };
    },
  };
}

export function installAttachmentImageTool(ctx, { log, toDefinition } = {}) {
  if (!ctx || typeof ctx.inject !== 'function' || typeof toDefinition !== 'function') return;
  try {
    ctx.inject(['tools', 'attachments', 'llm'], (sctx) => {
      const tools = sctx?.get?.('tools') ?? sctx?.tools;
      if (!tools || typeof tools.register !== 'function') {
        try {
          log?.warn?.('dsh-markdown-editor-typora: attachment image tool disabled: tools.register is unavailable');
        } catch {
        }
        return;
      }
      const getAttachments = () => {
        try {
          return sctx?.get?.('attachments');
        } catch {
          return undefined;
        }
      };
      const getLlm = () => {
        try {
          return sctx?.get?.('llm');
        } catch {
          return undefined;
        }
      };
      sctx.effect(() => {
        const definition = toDefinition(createSpec(getAttachments, getLlm));
        let existing;
        try {
          existing = tools.get?.(definition.name);
        } catch {
          existing = undefined;
        }
        if (existing !== undefined) {
          if (!ours.has(existing)) {
            try {
              log?.warn?.('dsh-markdown-editor-typora: attachment image tool disabled: tool name %s is already registered', definition.name);
            } catch {
            }
          }
          return () => {};
        }
        let dispose;
        try {
          dispose = tools.register(definition);
        } catch (error) {
          try {
            log?.warn?.('dsh-markdown-editor-typora: attachment image tool disabled: %s', String(error?.message ?? error));
          } catch {
          }
          return () => {};
        }
        try {
          ours.add(definition);
        } catch {
        }
        return () => {
          try {
            dispose?.();
          } catch (error) {
            try {
              log?.warn?.('dsh-markdown-editor-typora: attachment image dispose failed: %s', String(error?.message ?? error));
            } catch {
            }
          }
        };
      }, 'dsh-markdown-editor-typora: attachment image tool');
    });
  } catch (error) {
    try {
      log?.warn?.('dsh-markdown-editor-typora: attachment image tool disabled: %s', String(error?.message ?? error));
    } catch {
    }
  }
}
