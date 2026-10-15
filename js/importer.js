// One-time import of Bureen's ad history from the zip Claude prepared (history.json + media/).
async function uploadPoster(zip, a, be, pid) {
  if (!a.poster || !zip.file(a.poster)) return null;
  const blob = await zip.file(a.poster).async('blob');
  return be.upload(`${pid}/history-${a.history.importId}.poster.jpg`, new File([blob], 'poster.jpg', { type: 'image/jpeg' }));
}

export async function importHistory(file, be, data, onProgress) {
  if (!window.JSZip) throw new Error('Zip reader did not load. Refresh and try again.');
  const zip = await window.JSZip.loadAsync(file);
  const entry = zip.file('history.json');
  if (!entry) throw new Error('This is not an Ad Lab history file.');
  const bundle = JSON.parse(await entry.async('string'));
  const have = new Map(data.ads.filter((a) => a.history && a.history.importId).map((a) => [a.history.importId, a]));
  const ver = bundle.version || 1;
  const productFor = (kind) => data.products.find((p) => p.kind === kind && !p.archived) || data.products.find((p) => p.kind === 'crew') || data.products[0];
  const ads = bundle.ads || [];
  let done = 0, added = 0, resorted = 0;
  for (const a of ads) {
    done++;
    onProgress({ done, total: ads.length, msg: `Importing ${a.base_name}` });
    const old = have.get(a.history.importId);
    if (old) {
      // A newer history file re-sorts ads it brought in before. Ads you've moved since keep your choice.
      const oldVer = (old.history && old.history.bundleVersion) || 1;
      const touched = data.decisions.some((d) => d.ad_id === old.id);
      const patch = {};
      // Always restore the picture if it's missing.
      const hasMedia = old.media_path && await be.mediaUrl(old.media_path).catch(() => null);
      if (!hasMedia && a.media && zip.file(a.media)) {
        const blob = await zip.file(a.media).async('blob');
        patch.media_path = await be.upload(`${old.product_id}/history-${a.history.importId}.${a.media.split('.').pop()}`, new File([blob], a.media.split('/').pop(), { type: a.media_type }));
        patch.media_type = a.media_type;
      }
      if (ver > oldVer && !touched) {
        // A newer history file re-sorts ads it brought in before.
        Object.assign(patch, { stage: a.stage, result: a.result || null, tags: a.tags || {}, concept: old.concept || a.concept || null, angle: old.angle || a.angle || null, setup_era: a.setup_era || null, notes: a.notes || null, history: { ...a.history, bundleVersion: ver } });
        resorted++;
      } else if (ver > oldVer) {
        // You've moved this ad yourself: keep its folder, only fill in what's missing.
        if (!old.angle && a.angle) patch.angle = a.angle;
        if (!old.concept && a.concept) patch.concept = a.concept;
        if (a.setup_era && (!old.setup_era || old.setup_era === 'old' || old.setup_era === 'new')) patch.setup_era = a.setup_era;
        patch.history = { ...(old.history || {}), bundleVersion: ver };
        resorted++;
      }
      if (!(old.tags && old.tags.poster) || patch.tags) {
        const poster = await uploadPoster(zip, a, be, old.product_id);
        if (poster) patch.tags = { ...(patch.tags || old.tags || {}), poster };
      }
      if (Object.keys(patch).length) await be.update('ads', old.id, patch);
      continue;
    }
    const product = productFor(a.productKind);
    let media_path = null, media_type = null;
    if (a.media && zip.file(a.media)) {
      const blob = await zip.file(a.media).async('blob');
      const f = new File([blob], a.media.split('/').pop(), { type: a.media_type });
      media_path = await be.upload(`${product.id}/history-${a.history.importId}.${a.media.split('.').pop()}`, f);
      media_type = a.media_type;
    }
    const poster = await uploadPoster(zip, a, be, product.id);
    await be.insert('ads', {
      product_id: product.id, base_name: a.base_name, concept: a.concept || null, format: a.format, angle: a.angle || null,
      offer: a.offer || null, notes: a.notes || null, stage: a.stage, result: a.result || null, launched_on: a.launched_on || null,
      setup_era: a.setup_era || null, tags: { ...(a.tags || {}), ...(poster ? { poster } : {}) }, history: { ...a.history, bundleVersion: ver }, media_path, media_type, version: 1,
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
  return { added, resorted };
}
