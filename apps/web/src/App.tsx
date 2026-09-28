import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { SearchBox } from './components/SearchBox';
import Onboarding from './pages/Onboarding';
import Home from './pages/Home';
import Properties from './pages/Properties';
import PropertyDetail from './pages/PropertyDetail';
import Tenants from './pages/Tenants';
import AddTenant from './pages/AddTenant';
import TenantDetail from './pages/TenantDetail';
import RecordPayment from './pages/RecordPayment';
import Payments from './pages/Payments';
import Receipts from './pages/Receipts';
import ReceiptView from './pages/ReceiptView';
import Expenses from './pages/Expenses';
import Maintenance from './pages/Maintenance';
import Arrears from './pages/Arrears';
import Reports from './pages/Reports';
import SyncPage from './pages/SyncPage';
import Staff from './pages/Staff';
import SettingsPage from './pages/SettingsPage';
import BackupPage from './pages/BackupPage';
import { LockScreen } from './components/LockScreen';

export interface Bootstrap {
  initialized: boolean;
  locked?: boolean;
  users?: any[];
  org?: { id: string; name: string; terminology: string };
  user?: { id: string; full_name: string; role: string };
  sync?: { pendingChanges: number };
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [pending, setPending] = useState(0);
  const loc = useLocation();

  const refresh = () => api.get('/bootstrap').then((b) => { setBoot(b); setPending(b.sync?.pendingChanges ?? 0); });
  useEffect(() => { refresh().catch(() => setBoot({ initialized: false })); }, []);
  useEffect(() => {
    if (!boot?.initialized || boot.locked) return;
    api.get('/sync/status').then((s) => setPending(s.pendingChanges)).catch(() => {});
  }, [loc.pathname, boot?.initialized, boot?.locked]);

  if (boot === null) return null;
  if (!boot.initialized) return <Onboarding onDone={refresh} />;
  if (boot.locked) return <LockScreen users={boot.users ?? []} onUnlocked={refresh} />;

  const lock = () => api.post('/auth/lock').then(refresh);
  const role = boot.user?.role;

  const nav = [
    { to: '/', label: 'Home', ico: '🏠' },
    { to: '/properties', label: 'Properties', ico: '🏢' },
    { to: '/tenants', label: 'Tenants', ico: '👥' },
    { to: '/payments', label: 'Payments', ico: '💰' },
    { to: '/arrears', label: 'Arrears', ico: '📋' },
  ];
  const more = [
    { to: '/receipts', label: 'Receipts', ico: '🧾' },
    { to: '/expenses', label: 'Expenses', ico: '🧰' },
    { to: '/maintenance', label: 'Maintenance', ico: '🔧' },
    ...(role !== 'CARETAKER' ? [{ to: '/reports', label: 'Reports', ico: '📊' }] : []),
    { to: '/sync', label: 'Sync & Devices', ico: '🔄' },
    ...(role === 'OWNER' ? [
      { to: '/staff', label: 'Staff', ico: '🧑‍🤝‍🧑' },
      { to: '/backup', label: 'Backup', ico: '💾' },
    ] : []),
    { to: '/settings', label: 'Settings', ico: '⚙️' },
  ];

  return (
    <div className="shell">
      <aside className="sidebar no-print">
        <div className="brand">Kitabu<small>{boot.org?.name}</small></div>
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <span>{n.ico}</span> {n.label}
          </NavLink>
        ))}
        <div className="nav-section">More</div>
        {more.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <span>{n.ico}</span> {n.label}
          </NavLink>
        ))}
        <div className="nav-section">{boot.user?.full_name}</div>
        <a className="nav-item" style={{ cursor: 'pointer' }} onClick={lock}><span>🔒</span> Lock</a>
      </aside>

      <div className="main">
        <header className="topbar no-print">
          <SearchBox />
          <div className="spacer" />
          <span className={`sync-chip${pending > 0 ? ' pending' : ''}`} title="Saved locally is not the same as synced. Local sync arrives in Phase 4.">
            {pending > 0 ? `↻ ${pending} change${pending === 1 ? '' : 's'} waiting to sync` : '✓ Saved on this device'}
          </span>
        </header>

        <main className="content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/properties" element={<Properties />} />
            <Route path="/properties/:id" element={<PropertyDetail />} />
            <Route path="/tenants" element={<Tenants />} />
            <Route path="/tenants/new" element={<AddTenant />} />
            <Route path="/tenants/:id" element={<TenantDetail />} />
            <Route path="/payments" element={<Payments />} />
            <Route path="/payments/new" element={<RecordPayment />} />
            <Route path="/receipts" element={<Receipts />} />
            <Route path="/receipts/:id" element={<ReceiptView />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/maintenance" element={<Maintenance />} />
            <Route path="/arrears" element={<Arrears />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/sync" element={<SyncPage />} />
            <Route path="/staff" element={<Staff meRole={role} />} />
            <Route path="/settings" element={<SettingsPage meRole={role} />} />
            <Route path="/backup" element={<BackupPage meRole={role} />} />
          </Routes>
        </main>

        <nav className="bottom-nav no-print">
          {[...nav.slice(0, 4), { to: '/sync', label: 'More', ico: '☰' }].map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="ico">{n.ico}</span>{n.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
