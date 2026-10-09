import { Module } from '@nestjs/common';
import { InventoryConfigController, InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/** OOH inventory (M4): asset types, assets → mounts → faces, terms and availability blocks. */
@Module({
  controllers: [InventoryConfigController, InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
