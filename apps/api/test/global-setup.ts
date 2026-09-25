import { createTestDatabase } from '@ooh/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await createTestDatabase('api');
  project.provide('ownerUrl', database.ownerUrl);
  project.provide('appUrl', database.appUrl);
  return () => database.dispose();
}
