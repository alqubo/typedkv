# TypedKV

Typed tables on top of **Deno KV**: describe a table with a TypeScript interface and get CRUD with
automatic timestamps, consistent secondary indexes and optimistic concurrency, with no third-party
dependencies.

```ts
import { table } from "@alqubo/typedkv";

interface User {
  email: string;
  team: string;
  name: string;
}

const kv = await Deno.openKv();
const users = table<User>(kv, "users").withIndexes({ email: { unique: true }, team: {} });

const user = await users.set({ email: "a@b.com", team: "core", name: "User" });
await users.findBy("email", "a@b.com"); // Row<User> | null
```

## Install

```sh
deno add jsr:@alqubo/typedkv
```

## Why

Deno KV is an ordered key-value store with atomic transactions, but using it directly means
designing keys by hand everywhere, keeping secondary indexes in sync yourself, and storing values
nothing checks. `typedkv` is a thin layer on top that does not hide how KV works underneath: the key
layout is documented, the limits are respected, and nothing scans a whole table behind your back.

## The row

Your interface describes **your fields only**. The library adds four more:

| Field          | Type     | Who sets it                                   |
| -------------- | -------- | --------------------------------------------- |
| `id`           | `string` | A ULID generated on creation, ordered by time |
| `createdAt`    | `Date`   | On creation, and kept by every later write    |
| `updatedAt`    | `Date`   | On every write                                |
| `versionstamp` | `string` | Deno KV, on every write                       |

What you get back is `Row<User>`: your `User` plus those four. Declaring them in `User` is a type
error, so that there is only ever one source of truth:

```ts
interface Bad {
  id: string; // ← the IDE flags table<Bad>(kv, "bad")
  name: string;
}
```

## Writing and reading

```ts
// Create with a generated id
const user = await users.set({ email: "a@b.com", team: "core", name: "Alberto" });

// Upsert under an id of your own: creates or replaces the whole row
await users.set("u_123", { email: "a@b.com", team: "core", name: "Alberto" });

// Partial change: only the fields in the patch are touched
await users.update(user.id, { name: "Alberto G." });

await users.get(user.id); // Row<User> | null
await users.delete(user.id);

const { rows, cursor } = await users.list({ limit: 50 });
```

The names follow `Deno.Kv`: `set`, `get`, `delete` and `list` mean there what they mean here. The
difference between `set(id, value)` and `update(id, patch)` is that the first **replaces the whole
row** — anything you leave out is dropped — while the second only applies the fields in the patch.

`list` paginates with the KV cursor: an empty string means no rows are left.

```ts
let cursor = "";
do {
  const page = await users.list({ limit: 100, cursor });
  for (const row of page.rows) console.log(row.email);
  cursor = page.cursor;
} while (cursor !== "");
```

## Secondary indexes

They are declared by chaining `withIndexes`:

```ts
const users = table<User>(kv, "users").withIndexes({
  email: { unique: true },
  team: {}, // non-unique: duplicates allowed
});

await users.findBy("email", "a@b.com"); // Row<User> | null
await users.listBy("team", "core", { limit: 50 }); // { rows, cursor }
```

|                                   | `listBy`           | `findBy`         |
| --------------------------------- | ------------------ | ---------------- |
| Non-unique index (`{}`)           | every matching row | type error       |
| Unique index (`{ unique: true }`) | 0 or 1 row         | `Row<T> \| null` |

`findBy` exists only on unique indexes: with duplicates around, returning a single row would be an
arbitrary answer. Querying a field with no index does not compile either, since it would mean
walking the whole table.

Only **top-level, required** fields can be indexed, and only those of a type KV accepts as a key
part (`string`, `number`, `bigint`, `boolean`). Indexing an optional field is a type error: those
rows would be invisible to the index.

Index entries are maintained inside the same atomic transaction as the row, so no entry is ever left
pointing at stale data, and uniqueness is enforced with a `check` on the index key rather than by
reading first and hoping.

### Why the call is chained

TypeScript stops inferring type arguments as soon as you write one by hand, and `table<User>(…)`
writes one. If indexes were another argument to `table`, their shape would never reach the type and
`findBy` could not know which fields exist or which are unique. `withIndexes` takes no type
arguments, so it infers them.

A table with no indexes is a single call:

```ts
const logs = table<LogEntry>(kv, "logs");
```

## Runtime validation

Types are gone at runtime, so for data coming from outside (`JSON.parse`, a request body) you can
pass a type guard that runs on **every** write:

```ts
const users = table<User>(kv, "users", {
  validate: (v): v is User =>
    typeof v === "object" && v !== null &&
    typeof (v as User).email === "string" &&
    typeof (v as User).team === "string" &&
    typeof (v as User).name === "string",
});
```

When it fails the write throws `ValidationError` and KV is never touched. Be careful: a `v is User`
predicate is a claim TypeScript takes at face value; if you forget a field, neither the compiler nor
the library will tell you.

## Concurrency

`set`, `update` and `delete` read, change and write inside a `kv.atomic()` with a `check` on the
version they read. If someone slips in between the read and the write, the operation fails with
`ConflictError` instead of silently overwriting their change.

You can also demand a specific version, which is the equivalent of an HTTP `If-Match`:

```ts
// GET /users/1 → you return the row and its versionstamp
// PUT /users/1 → it comes back with the versionstamp the client read
await users.update(id, patch, { versionstamp: fromTheClient });
// ConflictError if someone else edited the row in the meantime

await users.set(id, value, { versionstamp: null }); // only if it does NOT exist
```

## Errors

| Error                   | When                                                        | Carries                   |
| ----------------------- | ----------------------------------------------------------- | ------------------------- |
| `ValidationError`       | The value did not pass the table's `validate`               | `table`, `value`          |
| `NotFoundError`         | `update` or `delete` on an id that does not exist           | `table`, `id`             |
| `ConflictError`         | The row changed, or the `versionstamp` is no longer current | `expected`, `actual`      |
| `UniqueConstraintError` | Another row already holds that value in a unique index      | `field`, `value`, `owner` |

They all extend `TypedKvError`, so `catch (e) { if (e instanceof TypedKvError) … }` covers them.

## Keys

Every key lives under a configurable prefix, `["tables"]` by default:

| Use              | Key                                                 | Value         |
| ---------------- | --------------------------------------------------- | ------------- |
| Row              | `[...prefix, <table>, "by_id", <id>]`               | The whole row |
| Unique index     | `[...prefix, <table>, "by_<field>", <value>]`       | `id`          |
| Non-unique index | `[...prefix, <table>, "by_<field>", <value>, <id>]` | `null`        |

A `Deno.Kv` is a shared database. With no prefix, a table named `users` would collide with any key
of yours starting with `"users"`, so the prefix keeps the library's keys apart from yours — and
doubles as a way to separate tenants or versions:

```ts
const users = table<User>(kv, "users", { prefix: ["myapp", "v1"] });
```

With `prefix: []` tables sit at the root of the KV, if you know what you are doing.

Ids are monotonic ULIDs, so walking `by_id` returns insertion order, even for rows created within
the same millisecond.

## Limits

Deno KV's own, measured and respected:

- An atomic transaction takes **1000 mutations and 100 checks**. One check is the row itself, so the
  ceiling is **99 unique indexes** per table; going over is an error when the table is declared, not
  on the first write.
- `getMany` takes **10 keys**, which is why `listBy` resolves rows in batches of 10.
- A value cannot exceed **64 KiB**, the whole row included.

## Reference

```ts
table<T>(kv: Deno.Kv, name: string, options?: TableOptions<T>): Table<T>

interface TableOptions<T> {
  prefix?: Deno.KvKey; // defaults to ["tables"]
  validate?: (value: unknown) => value is T;
}
```

| Method                           | Returns                                |
| -------------------------------- | -------------------------------------- |
| `withIndexes(indexes)`           | The same table, with its indexes typed |
| `set(value)`                     | `Row<T>` — creates with a generated id |
| `set(id, value, options?)`       | `Row<T>` — creates or replaces         |
| `get(id)`                        | `Row<T> \| null`                       |
| `update(id, patch, options?)`    | `Row<T>`                               |
| `delete(id, options?)`           | `void`                                 |
| `list(options?)`                 | `{ rows, cursor }`                     |
| `findBy(field, value)`           | `Row<T> \| null` — unique indexes only |
| `listBy(field, value, options?)` | `{ rows, cursor }`                     |

Write options are `{ versionstamp?: string \| null }`; list options are
`{ cursor?: string; limit?: number; reverse?: boolean }`.

## Development

```sh
deno task test     # tests, against an in-memory KV
deno task check    # type-check + lint + fmt
deno task sandbox  # runs sandbox.ts to try the library by hand
```

## License

MIT
