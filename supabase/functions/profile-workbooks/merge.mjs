export const EDITABLE_FIELDS = ['del_qty', 'del_status', 'delivery_notes'];
export const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function changedFields(a, b) {
  return EDITABLE_FIELDS.filter(key => !same(a[key], b[key]));
}
export function deliveryTotal(row) {
  const n = Number(row.QTY);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function validateValues(row, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) ||
      Object.keys(values).some(key => !EDITABLE_FIELDS.includes(key))) throw new Error('INVALID_FIELDS');
  const next = { ...row, ...values };
  if ('delivery_notes' in values && (typeof values.delivery_notes !== 'string' || values.delivery_notes.length > 2000)) throw new Error('INVALID_NOTES');
  if ('del_qty' in values || 'del_status' in values) {
    const qty = deliveryTotal(next);
    if (qty === null) {
      if (next.del_qty !== '' && next.del_qty !== 0) throw new Error('INVALID_QUANTITY');
    } else if (!Number.isSafeInteger(next.del_qty) || next.del_qty < 0 || next.del_qty > qty ||
      next.del_status !== (next.del_qty === qty ? 'Delivered' : '')) throw new Error('INVALID_QUANTITY');
    if (!['', 'Delivered'].includes(next.del_status)) throw new Error('INVALID_STATUS');
  }
  return next;
}
export function applyEdits(rows, edits) {
  if (!Array.isArray(edits) || !edits.length || edits.length > rows.length) throw new Error('INVALID_EDITS');
  const next = rows.map(row => ({ ...row }));
  const seen = new Set();
  for (const { index, values } of edits) {
    if (!Number.isInteger(index) || index < 0 || index >= rows.length || seen.has(index)) throw new Error('INVALID_ROW');
    seen.add(index);
    next[index] = validateValues(rows[index], values);
  }
  return next;
}
export function previewMerge(base, mine, original) {
  if (base.length !== mine.length || base.length !== original.length) throw new Error('ROW_STRUCTURE_CHANGED');
  return mine.flatMap((row, index) => {
    const fields = changedFields(base[index], row);
    if (!fields.length) return [];
    // Same values can represent two teams reporting the same physical cart.
    const conflict = changedFields(base[index], original[index]).length > 0;
    return [{ index, fields, conflict, base: base[index], mine: row, original: original[index] }];
  });
}
export function mergeRows(base, mine, original, resolutions = []) {
  const preview = previewMerge(base, mine, original);
  const choices = new Map();
  for (const choice of resolutions) {
    if (choices.has(choice.index) || !preview.some(row => row.index === choice.index && row.conflict)) throw new Error('INVALID_RESOLUTION');
    choices.set(choice.index, choice);
  }
  const rows = original.map(row => ({ ...row }));
  const changes = [];
  for (const item of preview) {
    let values = Object.fromEntries(item.fields.map(key => [key, mine[item.index][key] ?? null]));
    if (item.fields.some(key => key === 'del_qty' || key === 'del_status')) {
      values.del_qty = mine[item.index].del_qty ?? '';
      values.del_status = mine[item.index].del_status ?? '';
    }
    if (item.conflict) {
      const resolution = choices.get(item.index);
      if (!resolution) throw new Error('UNRESOLVED_CONFLICT');
      if (resolution.choice === 'original') continue;
      if (resolution.choice === 'count') {
        const total = deliveryTotal(original[item.index]);
        if (total === null || !Number.isSafeInteger(resolution.count) || resolution.count < 0 || resolution.count > total) throw new Error('INVALID_QUANTITY');
        // Manual count resolves delivery fields; other fields still use this profile's edits.
        values = { ...values, del_qty: resolution.count, del_status: resolution.count === total ? 'Delivered' : '' };
      } else if (resolution.choice !== 'mine') throw new Error('INVALID_RESOLUTION');
    }
    const after = { ...rows[item.index], ...values };
    const fields = changedFields(rows[item.index], after);
    if (!fields.length) continue;
    changes.push({ index: item.index, address: [after['CSADR#'], after.CSSDIR, after.CSSTRT, after.CSSFUX].filter(Boolean).join(' '),
      bin: String(after.BINNO ?? ''), fields: fields.map(field => ({ field, before: rows[item.index][field] ?? null, after: after[field] ?? null })) });
    rows[item.index] = after;
  }
  return { rows, changes, resolutions };
}
