/* eslint-disable @typescript-eslint/only-throw-error -- TanStack Router's `throw redirect()` is its documented control flow. */
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppLayout } from '@/app/app-layout';
import { NAV_ITEMS } from '@/app/navigation';
import { RequirePermission } from '@/app/require-permission';
import type { AuthContextValue } from '@/lib/auth';
import { DashboardPage } from '@/pages/dashboard-page';
import { LoginPage, safeRedirect } from '@/pages/login-page';
import { PlaceholderPage } from '@/pages/placeholder-page';
import { UsersPage } from '@/pages/users-page';

export interface RouterContext {
  auth: AuthContextValue;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/app' });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  // Also runs right after sign-in (auth change → router.invalidate), so it performs the post-login navigation.
  beforeLoad: ({ context, search }) => {
    if (context.auth.status === 'authenticated') throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginPage,
});

/** Everything under /app requires a session; the API still authorizes every call. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/app',
  beforeLoad: ({ context, location }) => {
    if (context.auth.status !== 'authenticated') {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: AppLayout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: () => (
    <RequirePermission permission="dashboard.read">
      <DashboardPage />
    </RequirePermission>
  ),
});

const usersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'admin/users',
  component: () => (
    <RequirePermission permission="users.read">
      <UsersPage />
    </RequirePermission>
  ),
});

/** Modules not built yet get a placeholder that names the delivering milestone. */
const placeholderRoutes = NAV_ITEMS.filter((item) => item.milestone).map((item) =>
  createRoute({
    getParentRoute: () => appRoute,
    path: item.path.replace(/^\/app\//, ''),
    component: () => (
      <RequirePermission permission={item.permission}>
        <PlaceholderPage item={item} />
      </RequirePermission>
    ),
  }),
);

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  appRoute.addChildren([dashboardRoute, usersRoute, ...placeholderRoutes]),
]);

export const router = createRouter({
  routeTree,
  context: { auth: undefined! },
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
