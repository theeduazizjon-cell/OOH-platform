import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from '@/lib/api';
import { AuthProvider, useAuth } from '@/lib/auth';
import { router } from '@/router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retrying 4xx responses (403, 404, 422) only repeats a deterministic failure.
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
    },
  },
});

function App() {
  const auth = useAuth();
  // Re-run route guards whenever the session starts or ends.
  useEffect(() => {
    void router.invalidate();
  }, [auth.status, auth.session?.tenantId]);

  if (auth.status === 'loading') {
    return <div className="flex h-full items-center justify-center text-sm text-slate-500">Loading…</div>;
  }
  return <RouterProvider router={router} context={{ auth }} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
