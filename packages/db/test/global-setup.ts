import type { TestProject } from 'vitest/node';
import { createTestDatabase } from '../src/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await createTestDatabase('db');
  project.provide('ownerUrl', database.ownerUrl);
  project.provide('appUrl', database.appUrl);
  return () => database.dispose();
}
