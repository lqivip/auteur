import React, { useEffect, useState } from 'react';
import { api, type Project } from '../api.js';
import { useI18n } from '../i18n.js';
import { useNav } from '../App.js';

const ASPECTS = ['16:9', '9:16', '1:1', '4:5', '3:4'];
const ASPECT_SIZE: Record<string, [number, number]> = {
  '16:9': [1280, 736],
  '9:16': [736, 1280],
  '1:1': [1024, 1024],
  '4:5': [1024, 1280],
  '3:4': [960, 1280],
};

export default function Projects() {
  const { t } = useI18n();
  const { go } = useNav();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [aspect, setAspect] = useState('9:16');

  const load = async () => {
    setLoading(true);
    try { setProjects(await api.get<Project[]>('/api/projects')); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    if (!name.trim()) return;
    const [w, h] = ASPECT_SIZE[aspect] ?? [736, 1280];
    await api.post('/api/projects', {
      name: name.trim(), short_name: shortName.trim(), aspect, default_width: w, default_height: h,
    });
    setName(''); setShortName('');
    void load();
  };

  const remove = async (p: Project) => {
    if (!window.confirm(t('projects.deleteConfirm'))) return;
    await api.del(`/api/projects/${p.id}?confirm=true`);
    void load();
  };

  const archive = async (p: Project) => {
    await api.patch(`/api/projects/${p.id}`, { archived: p.archived ? 0 : 1 });
    void load();
  };

  if (loading) return <p className="muted">{t('common.loading')}</p>;

  return (
    <div>
      <div className="page-head">
        <h1>{t('projects.title')}</h1>
      </div>

      <div className="card form-card">
        <h2>{t('projects.new')}</h2>
        <div className="form-row">
          <label>{t('projects.name')}
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>{t('projects.shortName')}
            <input value={shortName} onChange={(e) => setShortName(e.target.value)} />
          </label>
          <label>{t('projects.aspect')}
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <button className="btn primary" onClick={create}>{t('common.create')}</button>
        </div>
      </div>

      {projects.length === 0 && <p className="muted">{t('projects.empty')}</p>}
      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} className={`card project-card ${p.archived ? 'archived' : ''}`}>
            <button className="project-main" onClick={() => go({ name: 'board', projectId: p.id })}>
              <span className="project-name">{p.name}</span>
              <span className="badge">{p.aspect}</span>
              {p.archived ? <span className="badge warn">{t('projects.archived')}</span> : null}
              <span className="muted">
                {t('projects.progress', { done: p.completed_segments ?? 0, total: p.segments ?? 0 })}
              </span>
              <span className="muted small">
                {t('projects.updated')}: {new Date(p.updated_at).toLocaleString()}
              </span>
            </button>
            <div className="card-actions">
              <button className="btn ghost" onClick={() => archive(p)}>{t('projects.archive')}</button>
              <button className="btn ghost danger" onClick={() => remove(p)}>{t('common.delete')}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
