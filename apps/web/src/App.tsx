import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';

import { api, setActingUser, type OrgState, type UserRow } from './api.ts';
import { ErrorBanner } from './components.tsx';

import Onboarding from './pages/Onboarding.tsx';
import Dashboard from './pages/Dashboard.tsx';
import Properties from './pages/Properties.tsx';
import Tenants from './pages/Tenants.tsx';
import TenantDetail from './pages/TenantDetail.tsx';
import RecordPayment from './pages/RecordPayment.tsx';
import Payments from './pages/Payments.tsx';
import Receipts from './pages/Receipts.tsx';
import ReceiptDetail from './pages/ReceiptDetail.tsx';
import Settings from './pages/Settings.tsx';

// -- app state --------------------------------------------------------------------

interface AppState {
  state: OrgState | null;
  refreshState: () => Promise<void>;
  actingUser: UserRow | null;
  isOwner: boolean;
}

const AppContext = createContext<AppState>({
  state: null,
  refreshState: async () => {},
  actingUser: null,
  isOwner: false,
});

export function useApp(): AppState {
  return useContext(AppContext);
}

export default function App() {
  const [state, setState] = useState<OrgState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const refreshState = useCallback(async () => {
    try {
      const s = await api<OrgState>('/api/state');
      setState(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this device\'s books.');
    }
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  const users = state?.users ?? [];
  const acting = users.find((u) => u.id === state?.actingUserId) ?? null;

  // Keep the browser's chosen user in sync (the API reads it per request too).
  useEffect(() => {
    if (state?.bootstrapped === true && state.actingUserId != null) {
      setActingUser(state.actingUserId);
    }
  }, [state]);

  async function switchUser(userId: string): Promise<void> {
    setActingUser(userId);
    await refreshState();
  }

  if (state === null) {
    return (
      <div className="shell-center">
        {error !== null
          ? <ErrorBanner message={error} onDismiss={() => void refreshState()} />
          : <p className="empty">Opening your rent book…</p>}
      </div>
    );
  }

  if (state.bootstrapped !== true) {
    return <Onboarding onDone={async () => { await refreshState(); navigate('/'); }} />;
  }

  const ctx: AppState = {
    state,
    refreshState,
    actingUser: acting,
    isOwner: acting?.role === 'OWNER',
  };

  return (
    <AppContext.Provider value={ctx}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">📘</span>
            <div>
              <div className="brand-name">Kitabu</div>
              <div className="brand-sub">{state.org?.name}</div>
            </div>
          </div>
          <nav>
            <NavLink to="/">Home</NavLink>
            <NavLink to="/properties">Properties</NavLink>
            <NavLink to="/tenants">Tenants</NavLink>
            <NavLink to="/payments">Payments</NavLink>
            <NavLink to="/receipts">Receipts</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <div className="sidebar-foot">
            <span className="chip chip-green" title="Single-device mode — sync arrives in Milestone 5">
              ✓ Local — saved on this device
            </span>
            <div className="user-switch">
              <label htmlFor="acting-user">Acting as</label>
              <select
                id="acting-user"
                value={acting?.id ?? ''}
                onChange={(e) => void switchUser(e.target.value)}
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} ({u.role.toLowerCase()})
                  </option>
                ))}
              </select>
            </div>
          </div>
        </aside>
        <main className="main">
          {error !== null && <ErrorBanner message={error} onDismiss={() => void refreshState()} />}
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/properties" element={<Properties />} />
            <Route path="/tenants" element={<Tenants />} />
            <Route path="/tenants/:id" element={<TenantDetail />} />
            <Route path="/pay" element={<RecordPayment />} />
            <Route path="/payments" element={<Payments />} />
            <Route path="/receipts" element={<Receipts />} />
            <Route path="/receipts/:id" element={<ReceiptDetail />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<p className="empty">That screen does not exist.</p>} />
          </Routes>
        </main>
      </div>
    </AppContext.Provider>
  );
}
