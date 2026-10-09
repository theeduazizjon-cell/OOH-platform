import { Injectable } from '@nestjs/common';
import { type FileSubjectType } from '@ooh/contracts';
import { type Transaction } from '@ooh/db';
import { type Principal } from '../auth/principal';

/**
 * Who may see and attach files of a record: files have no permissions of their own, access follows
 * the record they are linked to (08-system-architecture.md §4). Modules register their record types.
 */
export interface FileSubjectPolicy {
  /** The record exists and the principal may read it. */
  canRead(tx: Transaction, principal: Principal, subjectId: string): Promise<boolean>;
  /** The principal may attach or remove files on it (record readable, open, and the right permission). */
  canWrite(tx: Transaction, principal: Principal, subjectId: string): Promise<boolean>;
}

@Injectable()
export class FileSubjects {
  private readonly policies = new Map<FileSubjectType, FileSubjectPolicy>();

  register(type: FileSubjectType, policy: FileSubjectPolicy): void {
    this.policies.set(type, policy);
  }

  policy(type: FileSubjectType): FileSubjectPolicy {
    const policy = this.policies.get(type);
    if (!policy) throw new Error(`No file policy for ${type}`);
    return policy;
  }
}
