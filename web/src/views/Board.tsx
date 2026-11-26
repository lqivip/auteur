import React, { useCallback, useEffect, useState } from 'react';
import { api, mediaUrl, uploadImage, type Character, type Project } from '../api.js';
import { useI18n } from '../i18n.js';
import { useNav } from '../App.js';

interface BoardSegment {
  id: string; seq: number; title: string; dialogue: string; first_frame: string | null; status: string;
}
interface BoardStoryboard {
  id: string; seq: number; title: string; segments: BoardSegment[];
}

const STATUS_KEY: Record<string, string> = {
  none: 'segStatus.none', queued: 'segStatus.queued', produced: 'segStatus.produced', selected: 'segStatus.selected',
};

export default function Board({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const { go } = useNav();
  const [project, setProject] = useState<Project | null>(null);
  const [storyboards, setStoryboards] = useState<BoardStoryboard[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [sbTitle, setSbTitle] = useState('');
  const [segTitles, setSegTitles] = useState<Record<string, string>>({});
  const [charName, setCharName] = useState('');
  const [charDesc, setCharDesc] = useState('');

  const load = useCallback(async () => {
    const board = await api.get<{ project: Project; storyboards: BoardStoryboard[] }>(`/api/projects/${projectId}/board`);
    setProject(board.project);
    setStoryboards(board.storyboards);
    setCharacters(await api.get<Character[]>(`/api/projects/${projectId}/characters`));
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const addStoryboard = async () => {
    await api.post(`/api/projects/${projectId}/storyboards`, { title: sbTitle });
    setSbTitle('');
    void load();
  };

  const addSegment = async (storyboardId: string) => {
    await api.post(`/api/storyboards/${storyboardId}/segments`, { title: segTitles[storyboardId] ?? '' });
    setSegTitles((s) => ({ ...s, [storyboardId]: '' }));
    void load();
  };

  const deleteSegment = async (id: string) => {
    await api.del(`/api/segments/${id}`);
    void load();
  };

  const duplicateSegment = async (id: string) => {
    await api.post(`/api/segments/${id}/duplicate`);
    void load();
  };

  const addCharacter = async () => {
    if (!charName.trim()) return;
    await api.post(`/api/projects/${projectId}/characters`, { name: charName.trim(), description: charDesc });
    setCharName(''); setCharDesc('');
    void load();
  };

  const addAnchor = async (characterId: string, file: File) => {
    const relPath = await uploadImage(file);
    await api.post(`/api/characters/${characterId}/images`, { path: relPath });
    void load();
  };

  if (!project) return <p className="muted">{t('common.loading')}</p>;

  return (
    <div>
      <div className="page-head">
        <button className="btn ghost" onClick={() => go({ name: 'projects' })}>← {t('nav.projects')}</button>
        <h1>{project.name}</h1>
        <span className="badge">{project.aspect}</span>
        <span className="muted">{project.default_width}×{project.default_height}</span>
      </div>

      <div className="card form-card">
        <div className="form-row">
          <label>{t('board.storyboardTitle')}
            <input value={sbTitle} onChange={(e) => setSbTitle(e.target.value)} />
          </label>
          <button className="btn primary" onClick={addStoryboard}>{t('board.addStoryboard')}</button>
        </div>
      </div>

      {storyboards.map((sb) => (
        <section key={sb.id} className="storyboard">
          <h2>E{sb.seq}{sb.title ? ` · ${sb.title}` : ''}</h2>
          {sb.segments.length === 0 && <p className="muted">{t('board.emptySegments')}</p>}
          <div className="segment-grid">
            {sb.segments.map((seg) => {
              const thumb = mediaUrl(seg.first_frame);
              return (
                <div key={seg.id} className="card segment-card">
                  <button className="segment-main" onClick={() => go({ name: 'segment', segmentId: seg.id, projectId })}>
                    {thumb
                      ? <img className="segment-thumb" src={thumb} alt="" />
                      : <div className="segment-thumb placeholder" />}
                    <span className="segment-title">E{sb.seq}-{seg.seq} {seg.title}</span>
                    <span className="muted small">{seg.dialogue.slice(0, 40)}</span>
                    <span className={`badge status-${seg.status}`}>{t(STATUS_KEY[seg.status] as any)}</span>
                  </button>
                  <div className="card-actions">
                    <button className="btn ghost" onClick={() => duplicateSegment(seg.id)}>⧉</button>
                    <button className="btn ghost danger" onClick={() => deleteSegment(seg.id)}>{t('common.delete')}</button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="form-row inline">
            <input
              placeholder={t('board.segmentTitle')}
              value={segTitles[sb.id] ?? ''}
              onChange={(e) => setSegTitles((s) => ({ ...s, [sb.id]: e.target.value }))}
            />
            <button className="btn" onClick={() => addSegment(sb.id)}>{t('board.addSegment')}</button>
          </div>
        </section>
      ))}

      <section className="storyboard">
        <h2>{t('board.characters')}</h2>
        <div className="card form-card">
          <div className="form-row">
            <label>{t('characters.name')}
              <input value={charName} onChange={(e) => setCharName(e.target.value)} />
            </label>
            <label>{t('characters.description')}
              <input value={charDesc} onChange={(e) => setCharDesc(e.target.value)} />
            </label>
            <button className="btn primary" onClick={addCharacter}>{t('characters.add')}</button>
          </div>
        </div>
        <div className="character-grid">
          {characters.map((c) => (
            <div key={c.id} className="card">
              <div className="character-head">
                <strong>{c.name}</strong>
                <span className="muted small">{c.description}</span>
              </div>
              <div className="anchor-row">
                {c.images.map((img) => (
                  <div key={img.id} className="anchor">
                    <img src={mediaUrl(img.path) ?? ''} alt={img.version} />
                    <span className="small">{img.version || '—'} {img.is_current ? `· ${t('characters.current')}` : ''}</span>
                  </div>
                ))}
                <label className="btn ghost anchor-add">
                  {t('characters.addAnchor')}
                  <input
                    type="file" accept="image/*" hidden
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void addAnchor(c.id, f); }}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
