import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TaskEvents } from './task-events';
import { TasksService } from './tasks.service';

/** Work (M2d): the task core. Exported so other modules create platform tasks in their transaction. */
@Module({
  controllers: [TasksController],
  providers: [TasksService, TaskEvents],
  exports: [TasksService],
})
export class TasksModule {}
