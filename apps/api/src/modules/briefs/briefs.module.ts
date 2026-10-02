import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { BriefsController } from './briefs.controller';
import { BriefsService } from './briefs.service';

/** Briefs (M3): client requests and their store lines, before they become campaigns. */
@Module({
  imports: [TasksModule],
  controllers: [BriefsController],
  providers: [BriefsService],
  exports: [BriefsService],
})
export class BriefsModule {}
