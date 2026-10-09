import { Global, Module } from '@nestjs/common';
import { OutboxDispatcher } from './outbox.dispatcher';
import { OutboxHandlers } from './outbox-handlers';

/** Event handlers registry and the dispatcher (started only by the worker entrypoint). */
@Global()
@Module({ providers: [OutboxHandlers, OutboxDispatcher], exports: [OutboxHandlers, OutboxDispatcher] })
export class OutboxModule {}
