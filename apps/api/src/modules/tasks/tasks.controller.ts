import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  createTaskRequestSchema,
  type Page,
  TASK_ACTIONS,
  type TaskAction,
  type TaskAssigneeCandidate,
  type TaskItem,
  taskListQuerySchema,
  updateTaskRequestSchema,
} from '@ooh/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentPrincipal, type Principal, RequirePermission } from '../../core/auth/principal';
import { AppError } from '../../core/http/app-error';
import { clientInfo } from '../../core/http/client-info';
import { type IfMatch, IfMatchHeader, VersionEtagInterceptor } from '../../core/http/concurrency';
import { parseWith } from '../../core/http/validation';
import { TasksService } from './tasks.service';

/** Tasks (docs/architecture/10-api.md): CRUD plus actions start, complete, cancel, reopen (If-Match). */
@Controller('tasks')
@UseInterceptors(VersionEtagInterceptor)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequirePermission('task.read')
  list(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<Page<TaskItem>> {
    return this.tasks.list(principal, parseWith(taskListQuerySchema, query));
  }

  /** Declared before ':id'. */
  @Get('assignees')
  @RequirePermission('task.create')
  assignees(@CurrentPrincipal() principal: Principal): Promise<TaskAssigneeCandidate[]> {
    return this.tasks.assignees(principal);
  }

  @Get(':id')
  @RequirePermission('task.read')
  get(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<TaskItem> {
    return this.tasks.get(principal, id);
  }

  @Post()
  @RequirePermission('task.create')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<TaskItem> {
    return this.tasks.create(principal, parseWith(createTaskRequestSchema, body), clientInfo(request));
  }

  @Patch(':id')
  @RequirePermission('task.update')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<TaskItem> {
    return this.tasks.update(
      principal,
      id,
      parseWith(updateTaskRequestSchema, body),
      ifMatch,
      clientInfo(request),
    );
  }

  @Post(':id/actions/:action')
  @HttpCode(200)
  @RequirePermission('task.update')
  act(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: string,
    @IfMatchHeader() ifMatch: IfMatch,
    @Req() request: FastifyRequest,
  ): Promise<TaskItem> {
    if (!(TASK_ACTIONS as readonly string[]).includes(action))
      throw new AppError('NOT_FOUND', 'Unknown action.');
    return this.tasks.transition(principal, id, action as TaskAction, ifMatch, clientInfo(request));
  }
}
