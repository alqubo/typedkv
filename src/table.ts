import { monotonicUlid } from "@std/ulid";
import { ConflictError, NotFoundError, UniqueConstraintError, ValidationError } from "./errors.ts";
import * as keys from "./keys.ts";
import type {
  IndexableValue,
  IndexDefinitions,
  IndexedField,
  ListOptions,
  ListResult,
  Row,
  StoredRow,
  Table,
  TableOptions,
  TableType,
  UniqueField,
  VersionCheck,
} from "./types.ts";

const SCHEMA_VERSION = 1;

const MAX_CHECKS = 100;
const MAX_MUTATIONS = 1000;
const MAX_GET_MANY = 10;

interface IndexEntry {
  field: string;
  value: Deno.KvKeyPart;
  unique: boolean;
  key: Deno.KvKey;
}

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
 * const users = table<User>(kv, "users").withIndexes({ email: { unique: true } });
 * const user = await users.set({ email: "a@b.com", name: "Alberto" });
 * await users.findBy("email", "a@b.com");
 * ```
 */
export function table<T extends TableType>(
  kv: Deno.Kv,
  name: string,
  options: TableOptions<T> = {},
): Table<T> {
  return build<T, Record<never, never>>(kv, name, options, {});
}

function build<T extends TableType, I extends IndexDefinitions<T>>(
  kv: Deno.Kv,
  name: string,
  options: TableOptions<T>,
  indexes: I,
): Table<T, I> {
  if (name.length === 0) {
    throw new TypeError("Table name cannot be empty.");
  }

  const prefix = options.prefix ?? keys.DEFAULT_PREFIX;

  const definitions = Object.entries(indexes) as [
    string,
    { unique?: boolean },
  ][];
  const uniqueCount = definitions.filter(([, def]) => def?.unique).length;

  if (uniqueCount + 1 > MAX_CHECKS) {
    throw new TypeError(
      `Table "${name}" declares ${uniqueCount} unique indexes, but a single atomic ` +
        `transaction allows ${MAX_CHECKS} checks, one of which is the row itself.`,
    );
  }
  if (definitions.length * 2 + 1 > MAX_MUTATIONS) {
    throw new TypeError(
      `Table "${name}" declares ${definitions.length} indexes, which needs more than ` +
        `the ${MAX_MUTATIONS} mutations a single atomic transaction allows.`,
    );
  }

  const validate = (value: unknown): T => {
    if (options.validate && !options.validate(value)) {
      throw new ValidationError(name, value);
    }
    return value as T;
  };

  const entriesOf = (id: string, data: T): IndexEntry[] =>
    definitions.map(([field, def]) => {
      const value = (data as Record<string, unknown>)[field] as IndexableValue;
      const unique = def?.unique === true;
      return {
        field,
        value,
        unique,
        key: keys.byIndex(prefix, name, field, value, unique ? undefined : id),
      };
    });

  const toRow = (stored: StoredRow<T>, versionstamp: string): Row<T> =>
    ({
      ...stored.data,
      id: stored.id,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      versionstamp,
    }) as Row<T>;

  const sameKey = (a: Deno.KvKey, b: Deno.KvKey) =>
    a.length === b.length && a.every((part, i) => part === b[i]);

  const assertUniqueFree = async (id: string, entries: IndexEntry[]) => {
    const unique = entries.filter((entry) => entry.unique);
    for (let i = 0; i < unique.length; i += MAX_GET_MANY) {
      const batch = unique.slice(i, i + MAX_GET_MANY);
      const found = await kv.getMany<string[]>(batch.map((entry) => entry.key));
      found.forEach((entry, j) => {
        if (entry.value !== null && entry.value !== id) {
          throw new UniqueConstraintError(name, batch[j].field, batch[j].value, entry.value);
        }
      });
    }
  };

  const write = async (
    id: string,
    stored: StoredRow<T>,
    previous: { versionstamp: string | null; data?: T },
  ): Promise<Row<T>> => {
    const key = keys.byId(prefix, name, id);
    const next = entriesOf(id, stored.data);
    const old = previous.data === undefined ? [] : entriesOf(id, previous.data);
    const stale = old.filter((entry) => !next.some((n) => sameKey(n.key, entry.key)));
    const fresh = next.filter((entry) => !old.some((o) => sameKey(o.key, entry.key)));

    await assertUniqueFree(id, fresh);

    let op = kv.atomic().check({ key, versionstamp: previous.versionstamp });
    for (const entry of fresh) {
      if (entry.unique) op = op.check({ key: entry.key, versionstamp: null });
    }
    for (const entry of stale) op = op.delete(entry.key);
    for (const entry of next) op = op.set(entry.key, entry.unique ? id : null);
    op = op.set(key, stored);

    const result = await op.commit();
    if (!result.ok) {
      await assertUniqueFree(id, fresh);
      throw new ConflictError(name, id);
    }
    return toRow(stored, result.versionstamp);
  };

  const read = async (id: string) => {
    const key = keys.byId(prefix, name, id);
    const entry = await kv.get<StoredRow<T>>(key);
    if (entry.value === null) throw new NotFoundError(name, id);
    return { key, value: entry.value, versionstamp: entry.versionstamp! };
  };

  const checkVersion = (id: string, current: string | null, options?: VersionCheck) => {
    if (options?.versionstamp !== undefined && options.versionstamp !== current) {
      throw new ConflictError(name, id, options.versionstamp, current);
    }
  };

  const rowsOf = async (ids: string[]): Promise<Row<T>[]> => {
    const rows: Row<T>[] = [];
    for (let i = 0; i < ids.length; i += MAX_GET_MANY) {
      const batch = ids.slice(i, i + MAX_GET_MANY);
      const found = await kv.getMany<StoredRow<T>[]>(
        batch.map((id) => keys.byId(prefix, name, id)),
      );
      for (const entry of found) {
        if (entry.value !== null) rows.push(toRow(entry.value, entry.versionstamp!));
      }
    }
    return rows;
  };

  return {
    name,

    withIndexes<const J extends IndexDefinitions<T>>(next: J): Table<T, J> {
      return build<T, J>(kv, name, options, next);
    },

    async set(idOrValue: string | T, maybeValue?: T, options?: VersionCheck): Promise<Row<T>> {
      const now = new Date();

      if (typeof idOrValue !== "string") {
        const data = validate(idOrValue);
        const id = monotonicUlid();
        return await write(
          id,
          { _v: SCHEMA_VERSION, id, createdAt: now, updatedAt: now, data },
          { versionstamp: null },
        );
      }

      const id = idOrValue;
      const entry = await kv.get<StoredRow<T>>(keys.byId(prefix, name, id));
      checkVersion(id, entry.versionstamp, options);

      const data = validate(maybeValue);
      return await write(
        id,
        {
          _v: SCHEMA_VERSION,
          id,
          createdAt: entry.value?.createdAt ?? now,
          updatedAt: now,
          data,
        },
        { versionstamp: entry.versionstamp, data: entry.value?.data },
      );
    },

    async get(id: string): Promise<Row<T> | null> {
      const entry = await kv.get<StoredRow<T>>(keys.byId(prefix, name, id));
      if (entry.value === null) return null;
      return toRow(entry.value, entry.versionstamp!);
    },

    async update(id: string, patch: Partial<T>, options?: VersionCheck): Promise<Row<T>> {
      const current = await read(id);
      checkVersion(id, current.versionstamp, options);

      const data = validate({ ...current.value.data, ...patch });
      return await write(
        id,
        { ...current.value, data, updatedAt: new Date() },
        { versionstamp: current.versionstamp, data: current.value.data },
      );
    },

    async delete(id: string, options?: VersionCheck): Promise<void> {
      const current = await read(id);
      checkVersion(id, current.versionstamp, options);

      let op = kv.atomic()
        .check({ key: current.key, versionstamp: current.versionstamp })
        .delete(current.key);
      for (const entry of entriesOf(id, current.value.data)) op = op.delete(entry.key);

      const result = await op.commit();
      if (!result.ok) throw new ConflictError(name, id);
    },

    async list(options: ListOptions = {}): Promise<ListResult<T>> {
      const iter = kv.list<StoredRow<T>>(
        { prefix: keys.byIdPrefix(prefix, name) },
        { cursor: options.cursor, limit: options.limit, reverse: options.reverse },
      );
      const rows: Row<T>[] = [];
      for await (const entry of iter) {
        rows.push(toRow(entry.value, entry.versionstamp));
      }
      return { rows, cursor: iter.cursor };
    },

    async findBy<K extends UniqueField<T, I>>(field: K, value: T[K]): Promise<Row<T> | null> {
      const key = keys.byIndex(prefix, name, field as string, value as IndexableValue);
      const pointer = await kv.get<string>(key);
      if (pointer.value === null) return null;
      const entry = await kv.get<StoredRow<T>>(keys.byId(prefix, name, pointer.value));
      if (entry.value === null) return null;
      return toRow(entry.value, entry.versionstamp!);
    },

    async listBy<K extends IndexedField<T, I>>(
      field: K,
      value: T[K],
      options: ListOptions = {},
    ): Promise<ListResult<T>> {
      const definition = definitions.find(([name]) => name === field)?.[1];
      if (definition?.unique) {
        const row = await this.findBy(field as never, value as never);
        return { rows: row === null ? [] : [row], cursor: "" };
      }

      const iter = kv.list<null>(
        { prefix: keys.byIndexPrefix(prefix, name, field as string, value as IndexableValue) },
        { cursor: options.cursor, limit: options.limit, reverse: options.reverse },
      );
      const ids: string[] = [];
      for await (const entry of iter) {
        ids.push(entry.key[entry.key.length - 1] as string);
      }
      return { rows: await rowsOf(ids), cursor: iter.cursor };
    },
  };
}
