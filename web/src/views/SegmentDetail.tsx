import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, mediaUrl, uploadImage, uploadMedia, type Channel, type Character, type Job, type Model, type Project, type Segment, type Take } from '../api.js';
import { useI18n } from '../i18n.js';
import { useNav } from '../App.js';

function snapFrames(frames: number): number {
  if (!Number.isFinite(frames) || frames <= 22) return 22;
  let best = 22;
  for (let k = 1; 17 * k + 5 <= frames + 17; k++) {
    const candidate = 17 * k + 5;
    if (Math.abs(candidate - frames) < Math.abs(best - frames)) best = candidate;
  }
  return best;
}

export function VerifyBadge({ status }: { status: string }) {
  const { t } = useI18n();
  if (status === 'verified') return <span className="badge ok">{t('verify.verified')}</span>;
  if (status === 'mismatch') return <span className="badge bad">{t('verify.mismatch')}</span>;
  return <span className="badge warn">{t('verify.unverified')}</span>;
}

interface Detail {
  segment: Segment;
  storyboard: { id: string; seq: number; title: string } | null;
  project: Project | null;
  takes: Take[];
  jobs: Job[];
}

export default function SegmentDetail({ segmentId, projectId }: { segmentId: string; projectId: string }) {
  const { t } = useI18n();
  const { go } = useNav();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [modelId, setModelId] = useState('');
  const [seedreamLora, setSeedreamLora] = useState(false);
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState('');

  // Editable segment fields
  const [title, setTitle] = useState('');
  const [dialogue, setDialogue] = useState('');
  const [prompt, setPrompt] = useState('');
  const [width, setWidth] = useState(736);
  const [height, setHeight] = useState(1280);
  const [frames, setFrames] = useState(124);
  const [seconds, setSeconds] = useState('5.2');
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(7);
  const [seed, setSeed] = useState(-1);
  const [sampler, setSampler] = useState('euler');
  const [scheduler, setScheduler] = useState('simple');

  const load = useCallback(async () => {
    const d = await api.get<Detail>(`/api/segments/${segmentId}`);
    setDetail(d);
    const seg = d.segment;
    setTitle(seg.title ?? '');
    setDialogue(seg.dialogue ?? '');
    setPrompt(seg.prompt ?? '');
    setWidth(seg.width ?? d.project?.default_width ?? 736);
    setHeight(seg.height ?? d.project?.default_height ?? 1280);
    const f = seg.frames ?? 124;
    setFrames(f);
    setSeconds(String(Math.round((f / (seg.fps || 24)) * 10) / 10));
    setSteps(seg.steps ?? 20);
    setCfg(seg.cfg ?? 7);
    setSeed(seg.seed ?? -1);
    setSampler(seg.sampler ?? 'euler');
    setScheduler(seg.scheduler ?? 'simple');
    setLabel(`${d.project?.short_name || d.project?.name || 'project'} / E${d.storyboard?.seq ?? 1}-${seg.seq} / video`);
    setModels(await api.get<Model[]>('/api/models'));
    setChannels(await api.get<Channel[]>('/api/channels'));
    setCharacters(await api.get<Character[]>(`/api/projects/${projectId}/characters`));
  }, [segmentId, projectId]);

  useEffect(() => { void load(); }, [load]);
  // Live-refresh while jobs are active.
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(timer);
  }, [load]);

  const channelById = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);
  const localModels = models.filter((m) => channelById.get(m.channel_id)?.type === 'comfyui');
  const externalModels = models.filter((m) => channelById.get(m.channel_id)?.type === 'openai-compatible');
  const selectedModel = models.find((m) => m.id === modelId);

  // Picking an h3-image / h3-fl2va model fills in its production defaults.
  const onModelChange = (id: string) => {
    setModelId(id);
    const m = models.find((x) => x.id === id);
    if (m?.adapter === 'h3-image') {
      setSteps(6);
      setCfg(1);
      setSampler('euler');
      setScheduler('simple');
      setSeedreamLora(Boolean(m.params?.seedream_lora));
    }
    if (m?.adapter === 'h3-fl2va') {
      setSteps(20);
      setSampler('res_multistep');
      setScheduler('simple');
    }
    if (m?.adapter === 'h3-ref2va') {
      setSteps(20);
      setSampler('res_multistep');
      setScheduler('simple');
    }
  };

  if (!detail) return <p className="muted">{t('common.loading')}</p>;
  const { segment: seg, project, takes, jobs } = detail;

  const save = async () => {
    await api.patch(`/api/segments/${seg.id}`, {
      title, dialogue, prompt, width, height, frames, steps, cfg, seed, sampler, scheduler,
    });
    setMessage('✓');
    void load();
  };

  const setFirstFrame = async (relPath: string) => {
    await api.patch(`/api/segments/${seg.id}`, { first_frame: relPath });
    void load();
  };

  const setLastFrame = async (relPath: string) => {
    await api.patch(`/api/segments/${seg.id}`, { last_frame: relPath });
    void load();
  };

  const setRefImages = async (paths: string[]) => {
    await api.patch(`/api/segments/${seg.id}`, { ref_images: paths });
    void load();
  };

  const addRefImage = async (relPath: string) => {
    const current = seg.ref_images ?? [];
    if (current.length >= 9) return; // node spec limit
    await setRefImages([...current, relPath]);
  };

  const removeRefImage = async (index: number) => {
    await setRefImages((seg.ref_images ?? []).filter((_, i) => i !== index));
  };

  const setRefAudio = async (relPath: string | null) => {
    await api.patch(`/api/segments/${seg.id}`, { ref_audio: relPath });
    void load();
  };

  const submit = async (purpose: 'video' | 'image') => {
    setMessage('');
    if (!label.trim()) { setMessage(t('segment.labelRequired')); return; }
    try {
      await save();
      const job = await api.post<Job>(`/api/segments/${seg.id}/jobs`, {
        label: label.trim(),
        purpose,
        model_id: modelId || undefined,
        settings: {
          width, height, frames, steps, cfg, seed, sampler, scheduler, prompt,
          ...(selectedModel?.adapter === 'h3-image' ? { seedream_lora: seedreamLora } : {}),
        },
      });
      const adj = (job.snapshot?.adjustments ?? []) as string[];
      setMessage(adj.length ? `⚠ ${adj.join('; ')}` : '✓');
      void load();
    } catch (err: any) {
      setMessage(`✗ ${err.message}`);
    }
  };

  const selectTake = async (take: Take) => {
    try {
      await api.post(`/api/takes/${take.id}/select`, {});
      void load();
    } catch (err: any) {
      if (err.status === 409 && window.confirm(t('segment.selectUnverifiedConfirm'))) {
        await api.post(`/api/takes/${take.id}/select`, { force: true });
        void load();
      } else if (err.status !== 409) {
        setMessage(`✗ ${err.message}`);
      }
    }
  };

  const deleteTake = async (take: Take) => {
    const isSelected = seg.selected_take_id === take.id;
    if (!window.confirm(isSelected ? t('segment.deleteSelectedConfirm') : t('segment.deleteTakeConfirm'))) return;
    await api.del(`/api/takes/${take.id}?confirm=true`);
    void load();
  };

  const anchors = characters.flatMap((c) => c.images.map((img) => ({ character: c, img })));
  const firstFrameUrl = mediaUrl(seg.first_frame);
  const lastFrameUrl = mediaUrl(seg.last_frame);
  const refImages = seg.ref_images ?? [];
  const showRefMaterial = selectedModel?.adapter === 'h3-ref2va' || refImages.length > 0 || Boolean(seg.ref_audio);
  const effectiveAspect = seg.aspect_override ?? project?.aspect ?? '9:16';

  return (
    <div>
      <div className="page-head">
        <button className="btn ghost" onClick={() => go({ name: 'board', projectId })}>← {t('segment.back')}</button>
        <h1>E{detail.storyboard?.seq ?? 1}-{seg.seq} {seg.title}</h1>
        <span className="badge">{effectiveAspect}</span>
      </div>

      <div className="detail-grid">
        <div className="card">
          <h2>{t('segment.firstFrame')}</h2>
          {firstFrameUrl
            ? <img className="first-frame" src={firstFrameUrl} alt="" />
            : <div className="first-frame placeholder" />}
          <div className="form-row">
            <label className="btn">
              {t('segment.changeFirstFrame')}
              <input
                type="file" accept="image/*" hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setFirstFrame(await uploadImage(f));
                }}
              />
            </label>
            <select
              value=""
              onChange={(e) => { if (e.target.value) void setFirstFrame(e.target.value); }}
            >
              <option value="">{t('segment.fromAnchor')}</option>
              {anchors.map(({ character, img }) => (
                <option key={img.id} value={img.path}>
                  {character.name} · {img.version || img.usage || img.id.slice(0, 6)}
                </option>
              ))}
            </select>
          </div>
          <h2>{t('segment.lastFrame')}</h2>
          {lastFrameUrl
            ? <img className="first-frame" src={lastFrameUrl} alt="" />
            : <div className="first-frame placeholder" />}
          <div className="form-row">
            <label className="btn">
              {t('segment.changeLastFrame')}
              <input
                type="file" accept="image/*" hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setLastFrame(await uploadImage(f));
                }}
              />
            </label>
            <select
              value=""
              onChange={(e) => { if (e.target.value) void setLastFrame(e.target.value); }}
            >
              <option value="">{t('segment.fromAnchor')}</option>
              {anchors.map(({ character, img }) => (
                <option key={img.id} value={img.path}>
                  {character.name} · {img.version || img.usage || img.id.slice(0, 6)}
                </option>
              ))}
            </select>
          </div>
          {showRefMaterial && (
            <>
              <h2>{t('segment.refImages')}</h2>
              <div className="ref-list">
                {refImages.map((p, i) => (
                  <div key={`${p}-${i}`} className="ref-item">
                    <img className="ref-thumb" src={mediaUrl(p) ?? ''} alt="" />
                    <span className="small">&lt;Picture {i + 1}&gt;</span>
                    <span className="small muted">{p.split('/').pop()}</span>
                    <button className="btn ghost danger" onClick={() => removeRefImage(i)}>{t('common.delete')}</button>
                  </div>
                ))}
              </div>
              <div className="form-row">
                <label className="btn">
                  {t('segment.addRefImage')}
                  <input
                    type="file" accept="image/*" hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) addRefImage(await uploadMedia(f));
                    }}
                  />
                </label>
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) void addRefImage(e.target.value); }}
                >
                  <option value="">{t('segment.fromAnchor')}</option>
                  {anchors.map(({ character, img }) => (
                    <option key={img.id} value={img.path}>
                      {character.name} · {img.version || img.usage || img.id.slice(0, 6)}
                    </option>
                  ))}
                </select>
              </div>
              <p className="muted small">{t('segment.refOrderHint')}</p>
              <h2>{t('segment.refAudio')}</h2>
              {seg.ref_audio && (
                <div className="form-row">
                  <span className="small">{seg.ref_audio.split('/').pop()}</span>
                  <button className="btn ghost danger" onClick={() => setRefAudio(null)}>{t('segment.clearRefAudio')}</button>
                </div>
              )}
              <div className="form-row">
                <label className="btn">
                  {t('segment.changeRefAudio')}
                  <input
                    type="file" accept="audio/*" hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) setRefAudio(await uploadMedia(f));
                    }}
                  />
                </label>
              </div>
              <p className="muted small">{t('segment.refAudioHint')}</p>
            </>
          )}
          <label className="block">{t('segment.dialogue')}
            <textarea rows={2} value={dialogue} onChange={(e) => setDialogue(e.target.value)} />
          </label>
          <label className="block">{t('segment.prompt')}
            <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
        </div>

        <div className="card">
          <h2>{t('segment.settings')}</h2>
          <label className="block">{t('projects.name')}
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="grid-2">
            <label>{t('segment.width')}
              <input type="number" step={32} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
            </label>
            <label>{t('segment.height')}
              <input type="number" step={32} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
            </label>
            <label>{t('segment.frames')}
              <input
                type="number" value={frames}
                onChange={(e) => { const f = snapFrames(Number(e.target.value)); setFrames(f); setSeconds(String(Math.round((f / 24) * 10) / 10)); }}
              />
            </label>
            <label>{t('segment.seconds')}
              <input
                type="number" step={0.1} value={seconds}
                onChange={(e) => { setSeconds(e.target.value); setFrames(snapFrames(Math.round(Number(e.target.value) * 24))); }}
              />
            </label>
            <label>{t('segment.steps')}
              <input type="number" value={steps} onChange={(e) => setSteps(Number(e.target.value))} />
            </label>
            <label>{t('segment.cfg')}
              <input type="number" step={0.1} value={cfg} onChange={(e) => setCfg(Number(e.target.value))} />
            </label>
            <label>{t('segment.seed')}
              <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
            </label>
            <label>{t('segment.sampler')}
              <input value={sampler} onChange={(e) => setSampler(e.target.value)} />
            </label>
            <label>{t('segment.scheduler')}
              <input value={scheduler} onChange={(e) => setScheduler(e.target.value)} />
            </label>
          </div>
          <p className="muted small">{t('segment.framesHint')}</p>
          <p className="muted small">
            {t('segment.snapshotNote')}: {width}×{height} · {frames}f · {effectiveAspect}
          </p>

          <label className="block">{t('segment.model')}
            <select value={modelId} onChange={(e) => onModelChange(e.target.value)}>
              <option value="">(route)</option>
              <optgroup label={t('segment.modelLocal')}>
                {localModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({channelById.get(m.channel_id)?.name})</option>
                ))}
              </optgroup>
              <optgroup label={t('segment.modelExternal')}>
                {externalModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} ({channelById.get(m.channel_id)?.name})</option>
                ))}
              </optgroup>
            </select>
          </label>
          {selectedModel?.adapter === 'h3-image' && (
            <>
              <p className="muted small">{t('segment.h3ImageDefaults')}</p>
              <label className="block">
                <input
                  type="checkbox" checked={seedreamLora}
                  onChange={(e) => setSeedreamLora(e.target.checked)}
                /> {t('segment.seedreamLora')}
              </label>
            </>
          )}
          {selectedModel?.adapter === 'h3-fl2va' && (
            <>
              <p className="muted small">{t('segment.h3Fl2vaDefaults')}</p>
              {!seg.first_frame && <p className="error small">{t('segment.fl2vaFirstFrameRequired')}</p>}
            </>
          )}
          {selectedModel?.adapter === 'h3-ref2va' && (
            <>
              <p className="muted small">{t('segment.h3Ref2vaDefaults')}</p>
              {refImages.length === 0 && <p className="error small">{t('segment.ref2vaRefImagesRequired')}</p>}
            </>
          )}
          <label className="block">{t('segment.label')}
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          {!label.trim() && <p className="error small">{t('segment.labelRequired')}</p>}
          <div className="form-row">
            <button className="btn" onClick={save}>{t('common.save')}</button>
            <button className="btn primary" onClick={() => submit('video')}>{t('segment.submitVideo')}</button>
            <button className="btn" onClick={() => submit('image')}>{t('segment.submitImage')}</button>
          </div>
          {message && <p className="small">{message}</p>}
        </div>
      </div>

      <section>
        <h2>{t('segment.takes')}</h2>
        {takes.length === 0 && <p className="muted">{t('segment.noTakes')}</p>}
        <div className="take-grid">
          {takes.map((take) => {
            const job = jobs.find((j) => j.id === take.job_id);
            const url = mediaUrl(take.file_path);
            return (
              <div key={take.id} className={`card take ${seg.selected_take_id === take.id ? 'selected' : ''}`}>
                {take.kind === 'image' && url
                  ? <img className="take-thumb" src={url} alt={take.file_name} />
                  : <div className="take-thumb placeholder">{take.file_name}</div>}
                <div className="small muted">{new Date(take.created_at).toLocaleString()} · {(take.size / 1024).toFixed(1)} KB</div>
                <VerifyBadge status={take.verify_status} />
                <div className="small">
                  {t('verify.expected')}: {job?.expected_model ?? '—'}<br />
                  {t('verify.actual')}: {take.actual_model ?? '—'}
                </div>
                <div className="card-actions">
                  {seg.selected_take_id === take.id
                    ? <span className="badge ok">{t('segment.selected')}</span>
                    : <button className="btn ghost" onClick={() => selectTake(take)}>{t('segment.select')}</button>}
                  <button className="btn ghost danger" onClick={() => deleteTake(take)}>{t('common.delete')}</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2>{t('segment.jobs')}</h2>
        <JobTable jobs={jobs} />
      </section>
    </div>
  );
}

export function JobTable({ jobs }: { jobs: Job[] }) {
  const { t } = useI18n();
  if (jobs.length === 0) return <p className="muted">{t('queue.empty')}</p>;
  const duration = (j: Job) => {
    if (!j.finished_at) return '—';
    const ms = Date.parse(j.finished_at) - Date.parse(j.submitted_at);
    return `${(ms / 1000).toFixed(1)}s`;
  };
  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t('queue.label')}</th><th>{t('queue.segment')}</th><th>{t('queue.submittedAt')}</th>
          <th>{t('queue.duration')}</th><th>status</th><th></th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id}>
            <td>{j.label}</td>
            <td>{j.project_name ? `${j.project_name} · ` : ''}{j.segment_title ?? j.segment_id.slice(0, 8)}</td>
            <td>{new Date(j.submitted_at).toLocaleString()}</td>
            <td>{duration(j)}</td>
            <td><span className={`badge status-job-${j.status}`}>{t(`status.${j.status}` as any)}</span></td>
            <td>
              {j.status === 'queued' && (
                <button className="btn ghost" onClick={async () => { await api.post(`/api/jobs/${j.id}/cancel`); }}>{t('queue.cancel')}</button>
              )}
              {j.status === 'running' && (
                <button className="btn ghost danger" onClick={async () => { await api.post(`/api/jobs/${j.id}/stop`); }}>{t('queue.stop')}</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
