// One-time import of Bureen's ad history from the zip Claude prepared (history.json + media/).
export async function importHistory(file, be, data, onProgress) {
  if (!window.JSZip) throw new Error('Zip reader did not load. Refresh and try again.');
  const zip = await window.JSZip.loadAsync(file);
  const entry = zip.file('history.json');
  if (!entry) throw new Error('This is not an Ad Lab history file.');
  const bundle = JSON.parse(await entry.async('string'));
  const have = new Set(data.ads.map((a) => a.history && a.history.importId).filter(Boolean));
  const productFor = (kind) => data.products.find((p) => p.kind === kind && !p.archived) || data.products.find((p) => p.kind === 'crew') || data.products[0];
  const ads = bundle.ads || [];
  let done = 0, added = 0;
  for (const a of ads) {
    done++;
    onProgress({ done, total: ads.length, msg: `Importing ${a.base_name}` });
    if (have.has(a.history.importId)) continue;
    const product = productFor(a.productKind);
    let media_path = null, media_type = null;
    if (a.media && zip.file(a.media)) {
      const blob = await zip.file(a.media).async('blob');
      const f = new File([blob], a.media.split('/').pop(), { type: a.media_type });
      media_path = await be.upload(`${product.id}/history-${a.history.importId}.${a.media.split('.').pop()}`, f);
      media_type = a.media_type;
    }
    await be.insert('ads', {
      product_id: product.id, base_name: a.base_name, concept: a.concept || null, format: a.format, angle: a.angle || null,
      offer: a.offer || null, notes: a.notes || null, stage: a.stage, result: a.result || null, launched_on: a.launched_on || null,
      setup_era: a.setup_era || null, tags: a.tags || {}, history: a.history, media_path, media_type, version: 1,
    });
    added++;
  }
  const haveText = new Set([...data.learnings.map((l) => l.text), ...data.events.map((e) => e.kind + '|' + e.day)]);
  for (const e of bundle.events || []) {
    if (haveText.has(e.kind + '|' + e.day)) continue;
    await be.insert('events', { product_id: e.productKind ? productFor(e.productKind).id : null, day: e.day, kind: e.kind, note: e.note || '' });
  }
  for (const l of bundle.learnings || []) {
    if (haveText.has(l.text)) continue;
    await be.insert('learnings', { product_id: l.productKind ? productFor(l.productKind).id : null, day: l.day, kind: l.kind || 'learning', text: l.text, source: l.source || 'Ad history review, Oct 2026' });
  }
  if (bundle.economics) {
    for (const [kind, econ] of Object.entries(bundle.economics)) {
      const p = productFor(kind);
      if (p && (!p.economics || !Object.keys(p.economics).length)) await be.update('products', p.id, { economics: econ });
    }
  }
  return added;
}
