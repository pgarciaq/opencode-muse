import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");

export function readRepositoryJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, relativePath), "utf8")) as T;
}

export function repositoryPath(relativePath: string): string {
  return resolve(REPOSITORY_ROOT, relativePath);
}
