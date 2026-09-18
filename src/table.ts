import { monotonicUlid } from "@std/ulid";
import { ConflictError, NotFoundError, ValidationError } from "./errors.ts";
import * as keys from "./keys.ts";
import type {
  ListOptions,
  ListResult,
  Row,
  StoredRow,
  Table,
  TableOptions,
  TableType,
  VersionCheck,
} from "./types.ts";

const SCHEMA_VERSION = 1;

/**
 * Defines a typed table on top of a `Deno.Kv`.
 *
 * `T` describes the user's fields only: `id`, `createdAt`, `updatedAt` and
 * `versionstamp` are added by the library, and declaring them in `T` is a type error.
 *
 * ```ts
 * interface User {
 *   email: string;
 *   name: string;
 * }
 *
 * const kv = await Deno.openKv(":memory:");
 * const users = table<User>(kv, "users");
 * const user = await users.set({ email: "a@b.com", name: "Alberto" });
 * ```
 */
export function table<T extends TableType>(
  kv: Deno.Kv,
  name: string,
  options: TableOptions<T> = {},
): Table<T> {
  if (name.length === 0) {
    throw new TypeError("Table name cannot be empty.");
  }

  const validate = (value: unknown): T => {
    if (options.validate && !options.validate(value)) {
      throw new ValidationError(name, value);
    }

    return value as T;
  };

  const toRow = (stored: StoredRow<T>, versionstamp: string): Row<T> =>
    ({
      ...stored.data,
      id: stored.id,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      versionstamp,
    }) as Row<T>;

  const read = async (id: string) => {
    const key = keys.byId(name, id);
    const entry = await kv.get<StoredRow<T>>(key);
    if (entry.value === null) throw new NotFoundError(name, id);
    return { key, value: entry.value, versionstamp: entry.versionstamp! };
  };

  const checkVersion = (id: string, current: string, options?: VersionCheck) => {
    if (options?.versionstamp !== undefined && options.versionstamp !== current) {
      throw new ConflictError(name, id, options.versionstamp, current);
    }
  };

  return {
    name,

    async set(
      idOrValue: string | T,
      maybeValue?: T,
      options?: VersionCheck,
    ): Promise<Row<T>> {
      const now = new Date();

      if (typeof idOrValue !== "string") {
        const data = validate(idOrValue);
        const id = monotonicUlid();
        const key = keys.byId(name, id);
        const stored: StoredRow<T> = {
          _v: SCHEMA_VERSION,
          id,
          createdAt: now,
          updatedAt: now,
          data,
        };

        const result = await kv.atomic()
          .check({ key, versionstamp: null })
          .set(key, stored)
          .commit();
        if (!result.ok) throw new ConflictError(name, id);
        return toRow(stored, result.versionstamp);
      }

      const id = idOrValue;
      const key = keys.byId(name, id);
      const entry = await kv.get<StoredRow<T>>(key);
      if (options?.versionstamp !== undefined && options.versionstamp !== entry.versionstamp) {
        throw new ConflictError(name, id, options.versionstamp, entry.versionstamp);
      }

      const data = validate(maybeValue);
      const stored: StoredRow<T> = {
        _v: SCHEMA_VERSION,
        id,
        createdAt: entry.value?.createdAt ?? now,
        updatedAt: now,
        data,
      };

      const result = await kv.atomic()
        .check({ key, versionstamp: entry.versionstamp })
        .set(key, stored)
        .commit();
      if (!result.ok) throw new ConflictError(name, id);
      return toRow(stored, result.versionstamp);
    },

    async get(id: string): Promise<Row<T> | null> {
      const entry = await kv.get<StoredRow<T>>(keys.byId(name, id));
      if (entry.value === null) return null;
      return toRow(entry.value, entry.versionstamp!);
    },

    async update(id: string, patch: Partial<T>, options?: VersionCheck): Promise<Row<T>> {
      const current = await read(id);
      checkVersion(id, current.versionstamp, options);

      const data = validate({ ...current.value.data, ...patch });
      const stored: StoredRow<T> = { ...current.value, data, updatedAt: new Date() };

      const result = await kv.atomic()
        .check({ key: current.key, versionstamp: current.versionstamp })
        .set(current.key, stored)
        .commit();
      if (!result.ok) throw new ConflictError(name, id);
      return toRow(stored, result.versionstamp);
    },

    async delete(id: string, options?: VersionCheck): Promise<void> {
      const current = await read(id);
      checkVersion(id, current.versionstamp, options);

      const result = await kv.atomic()
        .check({ key: current.key, versionstamp: current.versionstamp })
        .delete(current.key)
        .commit();
      if (!result.ok) throw new ConflictError(name, id);
    },

    async list(options: ListOptions = {}): Promise<ListResult<T>> {
      const iter = kv.list<StoredRow<T>>(
        { prefix: keys.byIdPrefix(name) },
        { cursor: options.cursor, limit: options.limit, reverse: options.reverse },
      );
      const rows: Row<T>[] = [];
      for await (const entry of iter) {
        rows.push(toRow(entry.value, entry.versionstamp));
      }
      return { rows, cursor: iter.cursor };
    },
  };
}
