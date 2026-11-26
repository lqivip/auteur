import React, { createContext, useContext, useState } from 'react';
import { I18nProvider, LanguageSwitcher, useI18n } from './i18n.js';
import Projects from './views/Projects.js';
import Board from './views/Board.js';
import SegmentDetail from './views/SegmentDetail.js';
import QueueView from './views/QueueView.js';
import SettingsView from './views/SettingsView.js';

export type Route =
  | { name: 'projects' }
  | { name: 'board'; projectId: string }
  | { name: 'segment'; segmentId: string; projectId: string }
  | { name: 'queue' }
  | { name: 'settings' };

interface NavCtx {
  route: Route;
  go: (r: Route) => void;
}

const Ctx = createContext<NavCtx>({ route: { name: 'projects' }, go: () => undefined });
export const useNav = () => useContext(Ctx);

function Shell() {
  const { t } = useI18n();
  const [route, setRoute] = useState<Route>({ name: 'projects' });
  const go = (r: Route) => setRoute(r);

  const navItem = (name: Route['name'], label: string, target: Route) => (
    <button
      key={name}
      className={`nav-item ${route.name === name ? 'active' : ''}`}
      onClick={() => go(target)}
    >
      {label}
    </button>
  );

  return (
    <Ctx.Provider value={{ route, go }}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">A</div>
            <div>
              <div className="brand-name">AUTEUR</div>
              <div className="brand-sub">{t('brand.tagline')}</div>
            </div>
          </div>
          <nav className="nav">
            {navItem('projects', t('nav.projects'), { name: 'projects' })}
            {navItem('queue', t('nav.queue'), { name: 'queue' })}
            {navItem('settings', t('nav.settings'), { name: 'settings' })}
          </nav>
          <div className="sidebar-foot">
            <LanguageSwitcher />
          </div>
        </aside>
        <main className="main">
          {route.name === 'projects' && <Projects />}
          {route.name === 'board' && <Board projectId={route.projectId} />}
          {route.name === 'segment' && <SegmentDetail segmentId={route.segmentId} projectId={route.projectId} />}
          {route.name === 'queue' && <QueueView />}
          {route.name === 'settings' && <SettingsView />}
        </main>
      </div>
    </Ctx.Provider>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}
