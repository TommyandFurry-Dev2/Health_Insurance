// The Chola MS ops screen (served at GET /chola-ms/ops). Reads the X-Ops-Key
// guarded /chola-ms/ops/* routes with the key the operator types; holds no data
// of its own. Kept out of the HTML because helmet's CSP blocks inline scripts.
(() => {
  const $ = (id) => document.getElementById(id);
  // '/chola-ms', or '/health/chola-ms' under the compatibility alias.
  const BASE = document.querySelector('meta[name="chola-base"]').content;
  const keyInput = $('key');
  try { keyInput.value = sessionStorage.getItem('cholaOpsKey') || ''; } catch (_) { /* storage blocked */ }

  function el(tag, text, cls) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }

  async function api(path) {
    const res = await fetch(`${BASE}${path}`, { headers: { 'X-Ops-Key': keyInput.value } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error?.message || `HTTP ${res.status}`);
    return body.data;
  }

  async function load() {
    try { sessionStorage.setItem('cholaOpsKey', keyInput.value); } catch (_) { /* storage blocked */ }
    $('status').textContent = 'Loading…';
    $('evidence').replaceChildren();
    try {
      const rows = await api('/ops/proposals?limit=200');
      const body = $('rows');
      body.replaceChildren();
      for (const r of rows) {
        const tr = el('tr');
        tr.append(el('td', r.gencon_proposal_number), el('td', r.product), el('td', r.payment_mode),
          el('td', r.amount != null ? `₹${r.amount}` : ''));
        const st = el('td'); st.append(el('span', r.status, `badge ${r.status}`)); tr.append(st);
        const detail = el('td');
        if (r.gencon_policy_number) detail.append(el('div', `Policy ${r.gencon_policy_number}`));
        if (r.error_message) detail.append(el('div', r.error_message, 'err'));
        if (r.payment_url) detail.append(el('div', `Payment URL: ${r.payment_url}`, 'muted'));
        if (r.status === 'POLICY_ISSUED') {
          if (Number(r.has_policy_pdf)) {
            const a = el('a', 'Policy PDF');
            a.href = '#';
            a.onclick = (e) => { e.preventDefault(); openPdf(r.gencon_proposal_number); };
            detail.append(a);
          } else if (r.policy_pdf_error) {
            detail.append(el('div', `PDF: ${r.policy_pdf_error}`, 'muted'));
          }
        }
        tr.append(detail, el('td', r.updated_at, 'muted'));
        const act = el('td'); const b = el('button', 'Evidence');
        b.onclick = () => showEvidence(r.gencon_proposal_number); act.append(b); tr.append(act);
        body.append(tr);
      }
      $('status').textContent = rows.length ? `${rows.length} proposal(s).` : 'No proposals yet.';
    } catch (err) {
      $('status').replaceChildren(el('span', err.message, 'err'));
    }
  }

  async function showEvidence(no) {
    const box = $('evidence');
    box.replaceChildren(el('div', `Loading evidence for ${no}…`, 'muted'));
    try {
      const logs = await api(`/ops/proposals/${encodeURIComponent(no)}/PolicyGeneration`);
      box.replaceChildren(el('h1', `PolicyGeneration evidence: ${no}`));
      if (!logs.length) box.append(el('p', 'No PolicyGeneration request has been logged for this proposal.', 'muted'));
      for (const l of logs) {
        const card = el('div', null, 'card'); card.style.padding = '12px'; card.style.marginBottom = '12px';
        card.append(el('div', `${l.created_at} · ${l.source} · ${l.product} · HTTP ${l.http_status ?? 'none'} · ${l.duration_ms ?? '?'} ms`, 'muted'));
        card.append(el('div', `POST ${l.request_url}`));
        card.append(el('pre', `Headers: ${l.request_headers}`));
        card.append(el('pre', `Request:\n${l.request_body}`));
        card.append(el('pre', `Response:\n${l.response_body ?? '(none)'}`));
        if (l.error_message) card.append(el('div', `${l.error_code || 'ERROR'}: ${l.error_message}`, 'err'));
        box.append(card);
      }
    } catch (err) {
      box.replaceChildren(el('span', err.message, 'err'));
    }
  }

  async function openPdf(no) {
    const res = await fetch(`${BASE}/ops/proposals/${encodeURIComponent(no)}/pdf`, { headers: { 'X-Ops-Key': keyInput.value } });
    if (!res.ok) { $('status').replaceChildren(el('span', `PDF: HTTP ${res.status}`, 'err')); return; }
    window.open(URL.createObjectURL(await res.blob()), '_blank');
  }

  $('load').onclick = load;
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  if (keyInput.value) load();
})();
