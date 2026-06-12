import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Reset } from './pages/Reset';
import { Receipts } from './pages/Receipts';
import { ReceiptDetailPage } from './pages/ReceiptDetailPage';
import { Stats } from './pages/Stats';
import { Pantry } from './pages/Pantry';
import { Shopping } from './pages/Shopping';
import { Names } from './pages/Names';
import { Stores } from './pages/Stores';
import { Queue } from './pages/Queue';
import { Admin } from './pages/Admin';
import { CategoriesAdmin } from './pages/CategoriesAdmin';
import { Profile } from './pages/Profile';
import { More } from './pages/More';
import { Spinner } from './components/ui';

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user?.is_admin) return <Navigate to="/receipts" replace />;
  return <>{children}</>;
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
          <Route path="/stats" element={<Stats />} />
          <Route path="/shopping" element={<Shopping />} />
          <Route path="/pantry" element={<Pantry />} />
          <Route path="/names" element={<Names />} />
          <Route path="/stores" element={<Stores />} />
          <Route path="/queue" element={<Queue />} />
          <Route path="/admin" element={<AdminOnly><Admin /></AdminOnly>} />
          <Route path="/admin/categories" element={<AdminOnly><CategoriesAdmin /></AdminOnly>} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/more" element={<More />} />
          <Route path="*" element={<Navigate to="/receipts" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
