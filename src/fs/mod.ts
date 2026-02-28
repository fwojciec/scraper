// Adapter: filesystem. Generic JSON file persistence.

import { dirname } from "@std/path";

/** Read/write/remove a typed JSON file. */
export interface JsonFileStore<T> {
  read(): Promise<T | null>;
  write(data: T): Promise<void>;
  remove(): Promise<void>;
}

/** Create a JSON file store backed by the given path. Writes are atomic (temp file + rename). */
export function createJsonFileStore<T>(path: string): JsonFileStore<T> {
  return {
    async read(): Promise<T | null> {
      try {
        const text = await Deno.readTextFile(path);
        return JSON.parse(text) as T;
      } catch (e) {
        if (e instanceof Deno.errors.NotFound || e instanceof SyntaxError) {
          return null;
        }
        throw e;
      }
    },

    async write(data: T): Promise<void> {
      const dir = dirname(path);
      await Deno.mkdir(dir, { recursive: true });
      const tmp = await Deno.makeTempFile({ dir });
      await Deno.writeTextFile(tmp, JSON.stringify(data));
      await Deno.rename(tmp, path);
    },

    async remove(): Promise<void> {
      try {
        await Deno.remove(path);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    },
  };
}
