import React, { useCallback, useEffect, useState } from 'react';
import { api, type Channel, type Model, type Project } from '../api.js';
import { LanguageSwitcher, useI18n } from '../i18n.js';

interface DiscoverResult { unets: string[]; checkpoints: string[]; loras: string[]; model_files: string[] }

const CAPABILITIES = ['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video', 'first-last-frame-to-video', 'reference-to-video'];
const ADAPTERS = ['comfy-video', 'comfy-image', 'openai-image', 'h3-image', 'h3-fl2va', 'h3-ref2va'];

export default function SettingsView() {
  const { t } = useI18n();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [dataDir, setDataDir] = useState('');
  const [message, setMessage] = useState('');

  // channel form
  const [chName, setChName] = useState('');
  const [chType, setChType] = useState<'comfyui' | 'openai-compatible'>('comfyui');
  const [chUrl, setChUrl] = useState('http://127.0.0.1:8188');
  const [chKey, setChKey] = useState('');

  // model form
  const [mChannel, setMChannel] = useState('');
  const [mName, setMName] = useState('');
  const [mFile, setMFile] = useState('');
  const [mCap, setMCap] = useState('text-to-video');
  const [mAdapter, setMAdapter] = useState('comfy-video');

  // discovery state per channel
  const [discovered, setDiscovered] = useState<Record<string, DiscoverResult>>({});
  const [fileSelection, setFileSelection] = useState<Record<string, Set<string>>>({});

  // route form
  const [routeProject, setRouteProject] = useState('');
  const [routePurpose, setRoutePurpose] = useState('video');
  const [routeModel, setRouteModel] = useState('');

  const load = useCallback(async () => {
    setChannels(await api.get<Channel[]>('/api/channels'));
    setModels(await api.get<Model[]>('/api/models'));
    setProjects(await api.get<Project[]>('/api/projects'));
    const settings = await api.get<{ data_dir: string }>('/api/settings');
    setDataDir(settings.data_dir);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const addChannel = async () => {
    if (!chName.trim() || !chUrl.trim()) return;
    await api.post('/api/channels', {
      name: chName.trim(), type: chType, base_url: chUrl.trim(), api_key: chKey || undefined,
    });
    setChName(''); setChKey('');
    void load();
  };

  const testChannel = async (ch: Channel) => {
    setMessage('…');
    const result = await api.post<any>(`/api/channels/${ch.id}/test`);
    setMessage(result.ok ? `${t('settings.testOk')} (${ch.name})` : `${t('settings.testFail')}: ${result.error ?? result.http_status ?? ''}`);
  };

  const discover = async (ch: Channel) => {
    const result = await api.get<DiscoverResult>(`/api/channels/${ch.id}/discover`);
    setDiscovered((d) => ({ ...d, [ch.id]: result }));
    setFileSelection((s) => ({ ...s, [ch.id]: new Set(result.model_files) }));
  };

  const saveFileSet = async (ch: Channel) => {
    const selected = [...(fileSelection[ch.id] ?? new Set<string>())];
    await api.patch(`/api/channels/${ch.id}`, { model_files: selected });
    setMessage('✓');
    void load();
  };

  const importModel = async (ch: Channel, file: string, kind: 'unet' | 'checkpoint') => {
    await api.post('/api/models', {
      channel_id: ch.id,
      name: file,
      file_name: file,
      capability: kind === 'unet' ? 'text-to-video' : 'text-to-image',
      adapter: kind === 'unet' ? 'comfy-video' : 'comfy-image',
    });
    void load();
  };

  const addModel = async () => {
    if (!mChannel || !mName.trim()) return;
    await api.post('/api/models', {
      channel_id: mChannel, name: mName.trim(), file_name: mFile || null, capability: mCap, adapter: mAdapter,
    });
    setMName(''); setMFile('');
    void load();
  };

  const saveRoute = async () => {
    if (!routeProject || !routeModel) return;
    await api.post('/api/routes', { project_id: routeProject, purpose: routePurpose, model_id: routeModel });
    setMessage('✓');
  };

  const updateKey = async (ch: Channel, value: string) => {
    if (!value) return;
    await api.patch(`/api/channels/${ch.id}`, { api_key: value });
    void load();
  };

  return (
    <div>
      <div className="page-head"><h1>{t('settings.title')}</h1></div>
      {message && <p className="small">{message}</p>}

      <section className="card">
        <h2>{t('settings.language')}</h2>
        <LanguageSwitcher />
        <p className="muted small">{t('settings.dataDir')}: <code>{dataDir}</code></p>
      </section>

      <section className="card">
        <h2>{t('settings.channels')}</h2>
        <div className="form-row">
          <label>{t('settings.channelName')}
            <input value={chName} onChange={(e) => setChName(e.target.value)} />
          </label>
          <label>{t('settings.channelType')}
            <select value={chType} onChange={(e) => setChType(e.target.value as any)}>
              <option value="comfyui">ComfyUI</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </label>
          <label>{t('settings.baseUrl')}
            <input value={chUrl} onChange={(e) => setChUrl(e.target.value)} />
          </label>
          <label>{t('settings.apiKey')}
            <input type="password" value={chKey} onChange={(e) => setChKey(e.target.value)} />
          </label>
          <button className="btn primary" onClick={addChannel}>{t('settings.addChannel')}</button>
        </div>

        {channels.map((ch) => {
          const disc = discovered[ch.id];
          const allFiles = disc ? [...disc.unets, ...disc.checkpoints, ...disc.loras] : [];
          return (
            <div key={ch.id} className="channel-block">
              <div className="channel-head">
                <strong>{ch.name}</strong>
                <span className="badge">{ch.type}</span>
                <span className="muted small">{ch.base_url}</span>
                {ch.has_key && <span className="muted small">key: {ch.api_key_masked}</span>}
                <span className={`badge ${ch.enabled ? 'ok' : 'warn'}`}>{ch.enabled ? t('common.enabled') : t('common.disabled')}</span>
                <button className="btn ghost" onClick={() => testChannel(ch)}>{t('settings.test')}</button>
                {ch.type === 'comfyui' && (
                  <button className="btn ghost" onClick={() => discover(ch)}>{t('settings.discover')}</button>
                )}
                <button
                  className="btn ghost"
                  onClick={async () => { await api.patch(`/api/channels/${ch.id}`, { enabled: !ch.enabled }); void load(); }}
                >
                  {ch.enabled ? t('common.disabled') : t('common.enabled')}
                </button>
                <button
                  className="btn ghost danger"
                  onClick={async () => { await api.del(`/api/channels/${ch.id}`); void load(); }}
                >
                  {t('common.delete')}
                </button>
              </div>
              {ch.type === 'openai-compatible' && (
                <div className="form-row">
                  <label>{t('settings.apiKey')}
                    <input
                      type="password" placeholder={t('settings.apiKeyKeep')}
                      onBlur={(e) => updateKey(ch, e.target.value)}
                    />
                  </label>
                </div>
              )}
              {disc && (
                <div className="discover-box">
                  <p className="small muted">{t('settings.modelFiles')}</p>
                  <div className="file-list">
                    {allFiles.map((f) => {
                      const selected = fileSelection[ch.id]?.has(f) ?? false;
                      const kind = disc.unets.includes(f) ? 'unet' : disc.checkpoints.includes(f) ? 'checkpoint' : 'lora';
                      return (
                        <div key={f} className="file-row">
                          <label>
                            <input
                              type="checkbox" checked={selected}
                              onChange={(e) => {
                                setFileSelection((s) => {
                                  const next = new Set(s[ch.id] ?? []);
                                  if (e.target.checked) next.add(f); else next.delete(f);
                                  return { ...s, [ch.id]: next };
                                });
                              }}
                            />
                            {f}
                          </label>
                          <span className="badge">{kind}</span>
                          {kind !== 'lora' && (
                            <button className="btn ghost" onClick={() => importModel(ch, f, kind as any)}>
                              {t('settings.import')}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <button className="btn" onClick={() => saveFileSet(ch)}>{t('common.save')}</button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="card">
        <h2>{t('settings.models')}</h2>
        <div className="form-row">
          <label>{t('settings.channelName')}
            <select value={mChannel} onChange={(e) => setMChannel(e.target.value)}>
              <option value="">—</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>{t('settings.modelName')}
            <input value={mName} onChange={(e) => setMName(e.target.value)} />
          </label>
          <label>{t('settings.fileName')}
            <input value={mFile} onChange={(e) => setMFile(e.target.value)} />
          </label>
          <label>{t('settings.capability')}
            <select value={mCap} onChange={(e) => setMCap(e.target.value)}>
              {CAPABILITIES.map((c) => <option key={c} value={c}>{t(`cap.${c}` as any)}</option>)}
            </select>
          </label>
          <label>{t('settings.adapter')}
            <select value={mAdapter} onChange={(e) => setMAdapter(e.target.value)}>
              {ADAPTERS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <button className="btn primary" onClick={addModel}>{t('settings.addModel')}</button>
        </div>
        <table className="table">
          <thead>
            <tr><th>{t('settings.modelName')}</th><th>{t('settings.fileName')}</th><th>{t('settings.capability')}</th><th>{t('settings.adapter')}</th><th></th></tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td>{m.file_name ?? '—'}</td>
                <td>{t(`cap.${m.capability}` as any)}</td>
                <td>{m.adapter}</td>
                <td>
                  <button className="btn ghost danger" onClick={async () => { await api.del(`/api/models/${m.id}`); void load(); }}>
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>{t('settings.routes')}</h2>
        <div className="form-row">
          <label>{t('projects.title')}
            <select value={routeProject} onChange={(e) => setRouteProject(e.target.value)}>
              <option value="">—</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>{t('segment.model')}
            <select value={routePurpose} onChange={(e) => setRoutePurpose(e.target.value)}>
              <option value="video">{t('purpose.video')}</option>
              <option value="image">{t('purpose.image')}</option>
            </select>
          </label>
          <label>{t('settings.modelName')}
            <select value={routeModel} onChange={(e) => setRouteModel(e.target.value)}>
              <option value="">—</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <button className="btn primary" onClick={saveRoute}>{t('settings.routeSave')}</button>
        </div>
      </section>
    </div>
  );
}
