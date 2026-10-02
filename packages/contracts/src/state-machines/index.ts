import type { PermissionKey } from '../permissions';

/**
 * Transition tables (docs/architecture/06-state-machines.md "Implementation pattern"): the API is the
 * authority, and the web app imports the same table to offer only the allowed actions.
 */
/** `to` of a resume: back to the status the subject had before it was put on hold. */
export const PREVIOUS_STATUS = 'PREVIOUS' as const;

export interface Transition<Status extends string, Action extends string> {
  action: Action;
  from: readonly Status[];
  to: Status | typeof PREVIOUS_STATUS;
  permission: PermissionKey;
}

export type TransitionTable<Status extends string, Action extends string> = Record<
  Action,
  Transition<Status, Action>
>;

/** Actions available from a status (ignoring permissions and guards). */
export function allowedActions<Status extends string, Action extends string>(
  table: TransitionTable<Status, Action>,
  status: Status,
): Action[] {
  return Object.values<Transition<Status, Action>>(table)
    .filter((t) => t.from.includes(status))
    .map((t) => t.action);
}

export * from './brief';
export * from './campaign';
