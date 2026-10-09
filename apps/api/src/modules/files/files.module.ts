import { Global, Module } from '@nestjs/common';
import { ENV } from '../../config/config.module';
import { type Env } from '../../config/env';
import { FileSubjects } from '../../core/files/file-subjects';
import { LocalFileStorage } from '../../core/files/local-storage';
import { S3FileStorage } from '../../core/files/s3-storage';
import { ClamdScanner, FILE_SCANNER, NoFileScanner } from '../../core/files/scanner';
import { FILE_STORAGE } from '../../core/files/storage';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { LocalStorageController } from './local-storage.controller';

/**
 * Files (M4b): storage (local disk in development, S3/MinIO otherwise), virus scanning, uploads and
 * downloads. Global so record modules can register their FileSubjects policy.
 */
@Global()
@Module({
  controllers: [FilesController, LocalStorageController],
  providers: [
    FileSubjects,
    FilesService,
    {
      provide: FILE_STORAGE,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.FILE_STORAGE === 's3'
          ? new S3FileStorage({
              endpoint: env.S3_ENDPOINT,
              region: env.S3_REGION,
              bucket: env.S3_BUCKET!,
              accessKeyId: env.S3_ACCESS_KEY_ID!,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
              forcePathStyle: env.S3_FORCE_PATH_STYLE,
            })
          : new LocalFileStorage(env.FILE_STORAGE_DIR, env.JWT_SECRET),
    },
    {
      provide: FILE_SCANNER,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.FILE_SCANNER === 'clamav'
          ? new ClamdScanner(env.CLAMAV_HOST, env.CLAMAV_PORT)
          : new NoFileScanner(),
    },
  ],
  exports: [FileSubjects, FilesService, FILE_STORAGE],
})
export class FilesModule {}
