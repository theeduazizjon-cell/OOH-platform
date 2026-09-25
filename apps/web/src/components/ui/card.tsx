import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-lg border border-slate-200 bg-white shadow-xs', className)} {...props} />
  );
}

export function Alert({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="alert"
      className={cn('rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800', className)}
      {...props}
    />
  );
}
