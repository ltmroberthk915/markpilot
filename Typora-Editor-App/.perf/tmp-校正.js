  let 上次可见 = null;
  /** 相邻行兜底：本行没有可见落点时，往上下找最近的可用落点（保证"永远不出现没有光标"）。 */
  const 邻行 = (锚, forward) => {
    if (!锚) return false;
    const box = root.getBoundingClientRect();
    for (let step = 1; step <= 40; step++) {
      for (const y of [Math.round(锚.top) + step * 6, Math.round(锚.top) - step * 6]) {
        if (y < box.top + 1 || y > box.bottom - 1) continue;
        const hit = 行端(y, y, forward);
        if (!hit) continue;
        const probe = doc.createRange();
        probe.setStart(hit.startContainer, hit.startOffset);
        probe.collapse(true);
        const rect = probe.getBoundingClientRect();
        if (!rect || !rect.height) continue;
        落(hit);
        上次可见 = {left: rect.left, top: rect.top, bottom: rect.bottom};
        return true;
      }
    }
    return false;
  };
  const 校正 = forward => {
    if (!root.isConnected) return;
    const rect = caretRect();
    if (!rect || 在坏位置里()) {
      const 锚 = rect ? {left: rect.left, top: rect.top, bottom: rect.bottom} : 上次可见;
      if (!锚) return;
      const midY = Math.round((锚.top + 锚.bottom) / 2);
      const hit = 行端(midY, Math.round(锚.top), forward) || (forward ? 公式源码末尾(midY) : null);
      if (!hit) { 邻行(锚, forward); return; }
      落(hit);
      // 落进去的可能是公式源码（折叠态看不见），Vditor 展开要晚一拍：
      // 下一拍再确认；仍然隐形就退到相邻行的可见位置——用户永远不该遇到"光标没了"。
      const 验 = () => {
        if (!root.isConnected) return;
        const 现在 = caretRect();
        if (现在) { 上次可见 = {left: 现在.left, top: 现在.top, bottom: 现在.bottom}; return; }
        邻行(锚, forward);
      };
      requestAnimationFrame(验);
      setTimeout(验, 60);
      return;
    }
    上次可见 = {left: rect.left, top: rect.top, bottom: rect.bottom};
  };
