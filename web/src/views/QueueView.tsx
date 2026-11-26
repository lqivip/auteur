import React, { useCallback, useEffect, useState } from 'react';
import { api, type Job } from '../api.js';
import { useI18n } from '../i18n.js';
import { JobTable } from './SegmentDetail.js';

const GROUPS = ['queued', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'stopped'] as const;

export default function QueueView() {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<Job[]>([]);

  const load = useCallback(async () => {
    setJobs(await api.get<Job[]>('/api/jobs'));
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div>
      <div className="page-head"><h1>{t('queue.title')}</h1></div>
      {jobs.length === 0 && <p className="muted">{t('queue.empty')}</p>}
      {GROUPS.map((status) => {
        const group = jobs.filter((j) => j.status === status);
        if (group.length === 0) return null;
        return (
          <section key={status}>
            <h2>{t(`status.${status}` as any)} · {group.length}</h2>
            <JobTable jobs={group} />
          </section>
        );
      })}
    </div>
  );
}
