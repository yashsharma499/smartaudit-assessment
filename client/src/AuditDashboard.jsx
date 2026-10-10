import React from 'react';
import { api } from './api.js';

const POLL_MS = 1500;

const EMPTY_FORM = {
  entityName: '',
  eventType: 'Control Execution',
  description: '',
  monetaryImpact: '',
  controlId: 'CTRL-FIN-302',
  actorUserId: 'user_1001',
};

const money = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;

function StatusBadge({ ai }) {
  if (ai.status === 'COMPLETED') {
    return <span className={`badge badge-${ai.riskLevel?.toLowerCase()}`}>{ai.riskLevel}</span>;
  }
  if (ai.status === 'FAILED') return <span className="badge badge-failed" title={ai.lastError || ''}>FAILED</span>;
  return (
    <span className={`badge badge-${ai.status.toLowerCase()}`}>
      <span className="spinner" /> {ai.status}
    </span>
  );
}

function VectorBars({ vector }) {
  if (!vector?.length) return null;
  return (
    <div className="vector" title={`semanticVector: [${vector.join(', ')}]`}>
      {vector.map((v, i) => (
        <span key={i} className={v >= 0 ? 'pos' : 'neg'} style={{ height: `${Math.max(2, Math.abs(v) * 22)}px` }} />
      ))}
    </div>
  );
}

/**
 * Primary UI, written as a React class component per the brief.
 * All UI state (rows, drafts, editor, similarity panel, toasts) lives in this.state.
 * The table polls GET /api/audit-entries so PENDING -> COMPLETED transitions stream in live.
 */
export default class AuditDashboard extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      entries: [],
      stats: {},
      health: null,
      loading: true,
      error: null,
      noteDrafts: {}, // id -> unsaved notes text
      savingIds: {}, // id -> true while a PUT is in flight
      editor: null, // { id, monetaryImpact, description, controlId }
      showForm: false,
      form: EMPTY_FORM,
      similar: null, // { id, evidenceId, loading, results, scanned, tookMs, error }
      flash: {}, // id -> true for a moment after its AI result lands
      toast: null,
    };
    this.pollTimer = null;
    this.toastTimer = null;
  }

  componentDidMount() {
    this.load();
    this.pollTimer = setInterval(() => this.load(), POLL_MS);
    api.health().then((health) => this.setState({ health })).catch(() => {});
  }

  componentWillUnmount() {
    clearInterval(this.pollTimer);
    clearTimeout(this.toastTimer);
  }

  async load() {
    try {
      const { entries, stats } = await api.list();
      this.setState((prev) => {
        // Highlight rows whose AI enrichment just completed since the last poll.
        const before = Object.fromEntries(prev.entries.map((e) => [e._id, e.aiMetadata.status]));
        const flash = {};
        for (const e of entries) {
          if (before[e._id] && before[e._id] !== 'COMPLETED' && e.aiMetadata.status === 'COMPLETED') flash[e._id] = true;
        }
        if (Object.keys(flash).length) setTimeout(() => this.setState({ flash: {} }), 1800);
        return { entries, stats, loading: false, error: null, flash: Object.keys(flash).length ? flash : prev.flash };
      });
    } catch (err) {
      this.setState({ loading: false, error: err.message });
    }
  }

  notify(message, kind = 'info') {
    clearTimeout(this.toastTimer);
    this.setState({ toast: { message, kind } });
    this.toastTimer = setTimeout(() => this.setState({ toast: null }), 4500);
  }

  setSaving(id, value) {
    this.setState((prev) => ({ savingIds: { ...prev.savingIds, [id]: value } }));
  }

  // ---- Auditor notes: fast-track path ------------------------------------------------
  handleNoteChange(id, text) {
    this.setState((prev) => ({ noteDrafts: { ...prev.noteDrafts, [id]: text } }));
  }

  async saveNotes(entry) {
    const id = entry._id;
    const text = this.state.noteDrafts[id];
    this.setSaving(id, true);
    const t0 = performance.now();
    try {
      const res = await api.update(id, { auditorNotes: text });
      const ms = Math.round(performance.now() - t0);
      this.setState((prev) => {
        const noteDrafts = { ...prev.noteDrafts };
        delete noteDrafts[id];
        return { noteDrafts, entries: prev.entries.map((e) => (e._id === id ? res.entry : e)) };
      });
      this.notify(
        res.path === 'FAST_TRACK'
          ? `⚡ Fast-tracked in ${ms} ms: notes saved with one atomic $set. AI not re-run, status stays ${res.entry.aiMetadata.status}.`
          : `No change detected (${res.path}).`,
        'success',
      );
    } catch (err) {
      this.notify(err.message, 'error');
    } finally {
      this.setSaving(id, false);
    }
  }

  // ---- Core field edit: AI re-queue path -----------------------------------------------
  openEditor(entry) {
    this.setState({ editor: { id: entry._id, monetaryImpact: entry.monetaryImpact, description: entry.description, controlId: entry.controlId } });
  }

  async saveEditor() {
    const { editor } = this.state;
    this.setSaving(editor.id, true);
    try {
      const res = await api.update(editor.id, {
        monetaryImpact: editor.monetaryImpact,
        description: editor.description,
        controlId: editor.controlId,
      });
      this.setState((prev) => ({ editor: null, entries: prev.entries.map((e) => (e._id === editor.id ? res.entry : e)) }));
      this.notify(
        res.path === 'AI_REQUEUE'
          ? `🔁 Core field changed (${res.changedFields.join(', ')}): back to PENDING, AI re-running (v${res.entry.aiMetadata.version}).`
          : 'No core field changed, so no AI recomputation was needed.',
        res.path === 'AI_REQUEUE' ? 'info' : 'success',
      );
    } catch (err) {
      this.notify(err.message, 'error');
    } finally {
      this.setSaving(editor.id, false);
    }
  }

  // ---- Create ------------------------------------------------------------------------
  async submitForm(e) {
    e.preventDefault();
    try {
      const entry = await api.create({ ...this.state.form, monetaryImpact: Number(this.state.form.monetaryImpact) });
      this.setState((prev) => ({ showForm: false, form: EMPTY_FORM, entries: [entry, ...prev.entries] }));
      this.notify(`Saved ${entry.evidenceId} as PENDING; the AI worker is enriching it in the background.`, 'info');
    } catch (err) {
      this.notify(err.message, 'error');
    }
  }

  // ---- Similarity ----------------------------------------------------------------------
  async findSimilar(entry) {
    this.setState({ similar: { id: entry._id, evidenceId: entry.evidenceId, description: entry.description, loading: true } });
    try {
      const res = await api.similar(entry._id);
      this.setState({ similar: { id: entry._id, evidenceId: entry.evidenceId, description: entry.description, loading: false, ...res } });
    } catch (err) {
      this.setState({ similar: { id: entry._id, evidenceId: entry.evidenceId, loading: false, error: err.message } });
    }
  }

  async retry(entry) {
    try {
      await api.retry(entry._id);
      this.notify(`${entry.evidenceId} re-queued.`, 'info');
      this.load();
    } catch (err) {
      this.notify(err.message, 'error');
    }
  }

  // ---- Render --------------------------------------------------------------------------
  renderHeader() {
    const { stats, health } = this.state;
    return (
      <header className="header">
        <div>
          <h1>Continuous Audit Stream</h1>
          <p className="sub">
            AI risk &amp; anomaly enrichment · engine: <b>{health?.ai ?? '…'}</b> · live refresh every {POLL_MS / 1000}s
          </p>
        </div>
        <div className="stats">
          {['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'].map((s) => (
            <div key={s} className={`stat stat-${s.toLowerCase()}`}>
              <span>{stats[s] ?? 0}</span>
              {s}
            </div>
          ))}
          <button className="btn primary" onClick={() => this.setState((p) => ({ showForm: !p.showForm }))}>
            {this.state.showForm ? 'Close' : '+ New entry'}
          </button>
        </div>
      </header>
    );
  }

  renderForm() {
    const { form } = this.state;
    const set = (k) => (e) => this.setState({ form: { ...form, [k]: e.target.value } });
    return (
      <form className="card form" onSubmit={(e) => this.submitForm(e)}>
        <input required placeholder="Entity name" value={form.entityName} onChange={set('entityName')} />
        <input required placeholder="Event type" value={form.eventType} onChange={set('eventType')} />
        <input required type="number" min="0" placeholder="Monetary impact ($)" value={form.monetaryImpact} onChange={set('monetaryImpact')} />
        <input required placeholder="Control ID" value={form.controlId} onChange={set('controlId')} />
        <input required placeholder="Actor user ID" value={form.actorUserId} onChange={set('actorUserId')} />
        <textarea required placeholder="Description, e.g. Manual approval override for urgent vendor payment" value={form.description} onChange={set('description')} />
        <button className="btn primary" type="submit">Submit evidence</button>
      </form>
    );
  }

  renderEditor(entry) {
    const { editor, savingIds } = this.state;
    const set = (k) => (e) => this.setState({ editor: { ...editor, [k]: e.target.value } });
    return (
      <tr className="editor-row">
        <td colSpan={7}>
          <div className="editor">
            <label>Amount ($)<input type="number" min="0" value={editor.monetaryImpact} onChange={set('monetaryImpact')} /></label>
            <label>Control ID<input value={editor.controlId} onChange={set('controlId')} /></label>
            <label className="grow">Description<input value={editor.description} onChange={set('description')} /></label>
            <button className="btn primary" disabled={savingIds[entry._id]} onClick={() => this.saveEditor()}>Save core fields</button>
            <button className="btn" onClick={() => this.setState({ editor: null })}>Cancel</button>
          </div>
          <p className="hint">Changing amount, description or control ID re-queues the AI. Unchanged values are detected and skipped.</p>
        </td>
      </tr>
    );
  }

  renderRow(entry) {
    const ai = entry.aiMetadata;
    const { noteDrafts, savingIds, editor, flash } = this.state;
    const draft = noteDrafts[entry._id];
    const notesValue = draft ?? ai.auditorNotes ?? '';
    const dirty = draft !== undefined && draft !== (ai.auditorNotes ?? '');
    const inFlight = ai.status === 'PENDING' || ai.status === 'PROCESSING';

    return (
      <React.Fragment key={entry._id}>
        <tr className={`${flash[entry._id] ? 'flash' : ''} ${inFlight ? 'inflight' : ''}`}>
          <td>
            <div className="mono">{entry.evidenceId}</div>
            <div className="muted">{entry.entityName}</div>
            <div className="muted small">{entry.controlId} · {entry.eventType}</div>
          </td>
          <td className="desc">
            {entry.description}
            {ai.anomalyFlags?.length > 0 && (
              <div className="flags">{ai.anomalyFlags.map((f) => <span key={f} className="flag">{f}</span>)}</div>
            )}
          </td>
          <td className="num">{money(entry.monetaryImpact)}</td>
          <td>
            <StatusBadge ai={ai} />
            <div className="muted small">v{ai.version}{ai.provider ? ` · ${ai.provider}` : ''}</div>
          </td>
          <td>
            {ai.riskScore != null ? (
              <div className="score">
                <div className="score-bar"><span style={{ width: `${ai.riskScore}%` }} className={`fill-${ai.riskLevel?.toLowerCase()}`} /></div>
                <b>{ai.riskScore}</b>
              </div>
            ) : <span className="muted">-</span>}
            <VectorBars vector={ai.semanticVector} />
          </td>
          <td className="summary">
            {ai.aiSummary ? <span className={inFlight ? 'stale' : ''}>{ai.aiSummary}</span> : <span className="muted">{inFlight ? 'AI enriching…' : '-'}</span>}
          </td>
          <td className="notes">
            <textarea value={notesValue} placeholder="Auditor notes…" onChange={(e) => this.handleNoteChange(entry._id, e.target.value)} />
            <div className="actions">
              <button className="btn small" disabled={!dirty || savingIds[entry._id]} onClick={() => this.saveNotes(entry)}>Save notes</button>
              <button className="btn small" onClick={() => this.openEditor(entry)}>Edit core</button>
              <button className="btn small accent" disabled={ai.status !== 'COMPLETED'} onClick={() => this.findSimilar(entry)}>Similar</button>
              {ai.status === 'FAILED' && <button className="btn small" onClick={() => this.retry(entry)}>Retry</button>}
            </div>
          </td>
        </tr>
        {editor?.id === entry._id && this.renderEditor(entry)}
      </React.Fragment>
    );
  }

  renderSimilar() {
    const { similar } = this.state;
    if (!similar) return null;
    return (
      <aside className="panel">
        <div className="panel-head">
          <div>
            <h2>Most similar to {similar.evidenceId}</h2>
            {similar.description && <p className="muted small">“{similar.description}”</p>}
          </div>
          <button className="btn small" onClick={() => this.setState({ similar: null })}>✕</button>
        </div>
        {similar.loading && <p className="muted"><span className="spinner" /> Comparing semantic vectors…</p>}
        {similar.error && <p className="error">{similar.error}</p>}
        {similar.results && (
          <>
            <p className="muted small">Cosine similarity over {similar.scanned} completed entries · {similar.tookMs} ms</p>
            {similar.results.length === 0 && <p className="muted">No other completed entries to compare.</p>}
            {similar.results.map((r, i) => (
              <div key={r._id} className="match">
                <div className="match-head">
                  <span className="rank">#{i + 1}</span>
                  <span className="mono">{r.evidenceId}</span>
                  <StatusBadge ai={{ ...r.aiMetadata, status: 'COMPLETED' }} />
                  <span className="sim">{Math.round(r.similarity * 100)}% match</span>
                </div>
                <div>{r.description}</div>
                <div className="muted small">{r.entityName} · {money(r.monetaryImpact)} · risk {r.aiMetadata.riskScore}</div>
              </div>
            ))}
          </>
        )}
      </aside>
    );
  }

  render() {
    const { entries, loading, error, showForm, toast } = this.state;
    return (
      <div className="page">
        {this.renderHeader()}
        {showForm && this.renderForm()}
        {error && <div className="error card">API error: {error}</div>}
        <div className="layout">
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Evidence</th>
                  <th>Description &amp; anomaly flags</th>
                  <th className="num">Amount</th>
                  <th>Status / Risk</th>
                  <th>Score &amp; vector</th>
                  <th>AI summary</th>
                  <th>Auditor notes &amp; actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="muted">Loading…</td></tr>}
                {!loading && entries.length === 0 && <tr><td colSpan={7} className="muted">No entries yet. Run <code>npm run seed</code> or add one.</td></tr>}
                {entries.map((e) => this.renderRow(e))}
              </tbody>
            </table>
          </div>
          {this.renderSimilar()}
        </div>
        {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
      </div>
    );
  }
}
