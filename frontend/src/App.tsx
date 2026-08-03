import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Reset } from './pages/Reset';
import { Receipts } from './pages/Receipts';
import { ReceiptDetailPage } from './pages/ReceiptDetailPage';
import { Positionen } from './pages/Positionen';
import { Pantry } from './pages/Pantry';
import { Shopping } from './pages/Shopping';
import { ShoppingHub } from './pages/ShoppingHub';
import { Artikel } from './pages/Artikel';
import { Warenstamm } from './pages/Warenstamm';
import { Stores } from './pages/Stores';
import { FilialProfil } from './pages/FilialProfil';
import { Offers } from './pages/Offers';
import { Ziele } from './pages/Ziele';
import { Finanzen } from './pages/Finanzen';
import { Queue } from './pages/Queue';
import { Admin } from './pages/Admin';
import { CategoriesAdmin } from './pages/CategoriesAdmin';
import { Households } from './pages/Households';
import { Profile } from './pages/Profile';
import { Spinner } from './components/ui';

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <img src="/icon-192.png" alt="" className="h-16 w-16 rounded-2xl" />
      <Spinner />
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user?.is_admin) return <Navigate to="/receipts" replace />;
  return <>{children}</>;
}

function SuperAdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user?.is_super_admin) return <Navigate to="/receipts" replace />;
  return <>{children}</>;
}

/** Redirect that preserves the query string (so old bookmarks/links with filters
 *  keep working after the Warenstamm reorg). */
function Redirect({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset" element={<Reset />} />
        <Route element={<Protected><Layout /></Protected>}>
          <Route path="/" element={<Navigate to="/receipts" replace />} />
          <Route path="/receipts" element={<Receipts />} />
          <Route path="/receipts/:id" element={<ReceiptDetailPage />} />
          {/* Statistik was folded into Finanzen (one page: summary, search/KI, the
              category tree, the plans). Old links and the Trend bar still point here. */}
          <Route path="/stats" element={<Redirect to="/finanzen" />} />
          {/* Shopping = hub with Liste / Angebote / Läden tabs (List is the default tab) */}
          <Route path="/shopping" element={<ShoppingHub />}>
            <Route index element={<Redirect to="/shopping/list" />} />
            <Route path="list" element={<Shopping />} />
            <Route path="offers" element={<Offers />} />
            <Route path="stores" element={<Stores />} />
          </Route>
          {/* Warenstamm = master-data hub with Artikel / Positionen / Vorrat / Prüfen tabs */}
          <Route path="/warenstamm" element={<Warenstamm />}>
            <Route index element={<Navigate to="artikel" replace />} />
            <Route path="artikel" element={<Artikel />} />
            <Route path="positionen" element={<Positionen />} />
            <Route path="vorrat" element={<Pantry />} />
            <Route path="pruefen" element={<Queue />} />
          </Route>
          {/* Legacy paths → new tabs (query string preserved for saved filters) */}
          <Route path="/names" element={<Redirect to="/warenstamm/artikel" />} />
          <Route path="/positionen" element={<Redirect to="/warenstamm/positionen" />} />
          <Route path="/pantry" element={<Redirect to="/warenstamm/vorrat" />} />
          <Route path="/queue" element={<Redirect to="/warenstamm/pruefen" />} />
          {/* Legacy shopping paths → hub tabs (query string preserved) */}
          <Route path="/stores" element={<Redirect to="/shopping/stores" />} />
          <Route path="/offers" element={<Redirect to="/shopping/offers" />} />
          <Route path="/filialen/:id" element={<FilialProfil />} />
          <Route path="/ziele" element={<Ziele />} />
          <Route path="/finanzen" element={<Finanzen />} />
          <Route path="/admin" element={<AdminOnly><Admin /></AdminOnly>} />
          <Route path="/admin/categories" element={<AdminOnly><CategoriesAdmin /></AdminOnly>} />
          {/* No nav entry any more — reached from the Haushalte section on the Admin page.
              The guard is what protects it, not the absence of a link. */}
          <Route path="/admin/households" element={<SuperAdminOnly><Households /></SuperAdminOnly>} />
          <Route path="/profile" element={<Profile />} />
          {/* /more is gone: the bottom bar holds all five entries now. Stale bookmarks
              fall through to the catch-all below and land on /receipts. */}
          <Route path="*" element={<Navigate to="/receipts" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
