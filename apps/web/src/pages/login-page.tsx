import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { LoginForm } from './login-form';

/** Only same-app paths are allowed as post-login destinations (no open redirects). */
export function safeRedirect(target: string | undefined): string {
  return target && target.startsWith('/app') && !target.startsWith('//') ? target : '/app';
}

export function LoginPage() {
  const auth = useAuth();

  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-xl font-semibold">OOH Platform</h1>
        <p className="mb-6 text-sm text-slate-500">Sign in to continue</p>
        <LoginForm
          // Navigation happens in the /login route guard once the session exists (see router.tsx).
          onSubmit={(email, password) => auth.login(email, password)}
        />
      </Card>
    </main>
  );
}
