import { z } from 'zod';
import { pageQuerySchema } from './pagination';

/**
 * Tasks core (docs/architecture/05-domain-model.md §work, 10-api.md "Tasks"). A task may be about a
 * company or an opportunity (polymorphic subject); its company is denormalised so it shows on the
 * Company 360°. Statuses: OPEN → IN_PROGRESS → DONE, cancel from either open status, reopen a closed one.
 */

export const TASK_STATUSES = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TASK_SUBJECT_TYPES = ['organisation', 'opportunity', 'campaign', 'campaign_location'] as const;
export type TaskSubjectType = (typeof TASK_SUBJECT_TYPES)[number];

/** Dedupe key of the task the platform creates when an opportunity is won (06-state-machines.md §2). */
export const wonOpportunityTaskKey = (opportunityId: string) => `opportunity.won:${opportunityId}`;
/** Dedupe key of a new location's research task (04-user-flows.md A5). */
export const locationResearchTaskKey = (locationId: string) => `campaign_location.research:${locationId}`;
/** Dedupe key of "Confirm store pin" when geocoding is ambiguous or fails (04-user-flows.md A6). */
export const locationPinTaskKey = (locationId: string) => `campaign_location.pin:${locationId}`;

export interface TaskItem {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  /** USER, or SYSTEM when the platform created it (e.g. "Create brief" after a win). */
  source: 'USER' | 'SYSTEM';
  dueAt: string | null;
  completedAt: string | null;
  assignee: { membershipId: string; displayName: string } | null;
  organisation: { id: string; displayName: string } | null;
  campaign: { id: string; code: string; name: string } | null;
  subject: { type: TaskSubjectType; id: string; name: string } | null;
  createdBy: { membershipId: string; displayName: string } | null;
  createdAt: string;
  version: number;
}

/** GET /tasks/assignees: active members who can see tasks (staff and external teams such as decorators). */
export interface TaskAssigneeCandidate {
  membershipId: string;
  displayName: string;
  kind: 'INTERNAL' | 'EXTERNAL';
}

const title = z.string().trim().min(1).max(200);
const notes = z.string().trim().max(5000);
const dueAt = z.iso.datetime({ offset: true });

/**
 * POST /tasks. The subject is an opportunity (its company is taken from it) or a company; both are
 * optional. The assignee defaults to the creator.
 */
export const createTaskRequestSchema = z
  .object({
    title,
    notes: notes.optional(),
    dueAt: dueAt.optional(),
    priority: z.enum(TASK_PRIORITIES).default('NORMAL'),
    assigneeMembershipId: z.uuid().nullable().optional(),
    organisationId: z.uuid().optional(),
    opportunityId: z.uuid().optional(),
  })
  .refine((body) => !(body.organisationId && body.opportunityId), {
    message: 'Give either the company or the opportunity (its company is implied)',
    path: ['organisationId'],
  });
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

/** PATCH /tasks/{id} (If-Match): open tasks only; statuses change through the actions. */
export const updateTaskRequestSchema = z
  .object({
    title: title.optional(),
    notes: notes.nullable().optional(),
    dueAt: dueAt.nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    assigneeMembershipId: z.uuid().nullable().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Nothing to change');
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export const TASK_ACTIONS = ['start', 'complete', 'cancel', 'reopen'] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/**
 * GET /tasks. `state=open` (default) is OPEN + IN_PROGRESS; `assignee` is `me`, `unassigned` or a
 * membership id. Ordered by due date (undated last), then creation.
 */
export const taskListQuerySchema = pageQuerySchema.extend({
  state: z.enum(['open', 'closed', 'all']).default('open'),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.uuid()]).optional(),
  organisationId: z.uuid().optional(),
  opportunityId: z.uuid().optional(),
  campaignId: z.uuid().optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
