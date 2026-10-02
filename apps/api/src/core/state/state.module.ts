import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { TransitionsService } from './transitions.service';

/** Cross-cutting state-change writers: status history, audit and the outbox. */
@Global()
@Module({ providers: [OutboxService, TransitionsService], exports: [OutboxService, TransitionsService] })
export class StateModule {}
