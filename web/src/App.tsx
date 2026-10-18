import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import ErrorBoundary from "@/components/error-boundary";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider, useSession } from "@/lib/session";
import Shell from "@/components/shell";
import Login from "@/pages/login";
import { Loader2 } from "lucide-react";

const ChatPage = lazy(() => import("@/pages/chat"));
const FilesPage = lazy(() => import("@/pages/files"));
const TerminalPage = lazy(() => import("@/pages/terminal"));
const AutomationsPage = lazy(() => import("@/pages/automations"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const AdminPage = lazy(() => import("@/pages/admin"));
const StubPage = lazy(() => import("@/pages/stub"));

const Spinner = () => (
  <div className="flex h-full items-center justify-center text-muted-foreground">
    <Loader2 className="size-5 animate-spin" />
  </div>
);

function Gate() {
  const { boot } = useSession();
  if (!boot) return <Spinner />;
  if (!boot.user) return <Login />;
  return (
    <Shell>
      <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={<ChatPage key="new" />} />
        <Route path="/c/:id" element={<ChatPage />} />
        <Route path="/files/*" element={<FilesPage />} />
        <Route path="/terminal" element={<TerminalPage />} />
        <Route path="/automations" element={<AutomationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/admin" element={boot.user.role === "admin" ? <AdminPage /> : <Navigate to="/" replace />} />
        <Route path="/unavailable/:feature" element={<StubPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </Shell>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <BrowserRouter>
          <SessionProvider>
            <Toaster />
            <Gate />
          </SessionProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </ThemeProvider>
  );
}
