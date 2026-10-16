import { Module } from '@nestjs/common';
import { InventoryImportController } from './inventory-import.controller';
import { InventoryImportService } from './inventory-import.service';
import { InventoryConfigController, InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/** OOH inventory (M4): asset types, assets → mounts → faces, terms and availability blocks; CSV import. */
@Module({
  controllers: [InventoryConfigController, InventoryController, InventoryImportController],
  providers: [InventoryService, InventoryImportService],
  exports: [InventoryService],
})
export class InventoryModule {}
