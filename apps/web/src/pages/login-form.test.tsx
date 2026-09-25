import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { LoginForm } from './login-form';
import { safeRedirect } from './login-page';

describe('LoginForm', () => {
  it('submits the trimmed email and the password', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<LoginForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Email'), '  admin@demo.local ');
    await userEvent.type(screen.getByLabelText('Password'), 'secret password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onSubmit).toHaveBeenCalledWith('admin@demo.local', 'secret password');
  });

  it.each([
    ['INVALID_CREDENTIALS', 401, 'Incorrect email or password.'],
    ['RATE_LIMITED', 429, 'Too many failed attempts'],
    ['NO_ACTIVE_MEMBERSHIP', 403, 'no active access'],
  ])('shows a helpful message for %s', async (code, status, text) => {
    const onSubmit = () =>
      Promise.reject(new ApiError(status, { code, status, title: code, type: 'x' } as never));
    render(<LoginForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.c');
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });
});

describe('safeRedirect', () => {
  it('only allows in-app destinations', () => {
    expect(safeRedirect('/app/admin/users')).toBe('/app/admin/users');
    expect(safeRedirect(undefined)).toBe('/app');
    expect(safeRedirect('https://evil.example')).toBe('/app');
    expect(safeRedirect('//evil.example/app')).toBe('/app');
  });
});
