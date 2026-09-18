import { assertEquals } from "@std/assert";
import { table } from "../src/mod.ts";
import type { Row } from "../src/mod.ts";
import type { User } from "./helpers.ts";
import { withKv } from "./helpers.ts";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
  : false;

type _IdIsString = Assert<Equal<Row<User>["id"], string>>;
type _CreatedAtIsDate = Assert<Equal<Row<User>["createdAt"], Date>>;
type _UserFieldIsKept = Assert<Equal<Row<User>["email"], string>>;
type _OptionalStaysOptional = Assert<Equal<Row<User>["age"], number | undefined>>;

Deno.test("a table type cannot declare the managed fields", async () => {
  await withKv((kv) => {
    interface WithId {
      id: string;
      name: string;
    }
    // @ts-expect-error `id` is managed by the library.
    table<WithId>(kv, "bad");

    interface WithCreatedAt {
      createdAt: Date;
      name: string;
    }
    // @ts-expect-error `createdAt` is managed by the library.
    table<WithCreatedAt>(kv, "bad");

    interface WithVersionstamp {
      versionstamp: string;
      name: string;
    }
    // @ts-expect-error `versionstamp` is managed by the library.
    table<WithVersionstamp>(kv, "bad");

    return Promise.resolve();
  });
});

Deno.test("set demands the exact table type", async () => {
  await withKv(async (kv) => {
    const users = table<User>(kv, "users");

    // @ts-expect-error `name` is missing.
    await users.set({ email: "a@b.com" });

    // @ts-expect-error `age` is not a string.
    await users.set({ email: "a@b.com", name: "Alberto", age: "30" });

    // @ts-expect-error `nombre` is not a field of User.
    await users.set({ email: "a@b.com", name: "Alberto", nombre: "Alberto" });

    // @ts-expect-error managed fields are not passed by hand.
    await users.set({ email: "a@b.com", name: "Alberto", id: "x" });

    const ok = await users.set({ email: "a@b.com", name: "Alberto" });
    assertEquals(typeof ok.id, "string");
  });
});

Deno.test("update only accepts a partial patch of the type", async () => {
  await withKv(async (kv) => {
    const users = table<User>(kv, "users");
    const user = await users.set({ email: "a@b.com", name: "Alberto" });

    await users.update(user.id, { name: "Alberto G." });

    // @ts-expect-error wrong type in the patch.
    await users.update(user.id, { name: 42 });

    // @ts-expect-error unknown field in the patch.
    await users.update(user.id, { nombre: "Alberto" });

    // @ts-expect-error managed fields cannot be patched.
    await users.update(user.id, { createdAt: new Date() });
  });
});

Deno.test("returned rows expose the managed fields and nothing else", async () => {
  await withKv(async (kv) => {
    const users = table<User>(kv, "users");
    const user = await users.set({ email: "a@b.com", name: "Alberto" });

    // @ts-expect-error `nombre` is not a field of the row.
    user.nombre;

    const { rows } = await users.list();
    // @ts-expect-error rows from `list` are typed the same way.
    rows[0]?.nombre;

    assertEquals(user.email, "a@b.com");
  });
});

Deno.test("only declared indexes can be queried, and findBy only unique ones", async () => {
  await withKv(async (kv) => {
    interface Member {
      email: string;
      team: string;
      name: string;
    }
    const members = table<Member>(kv, "members").withIndexes({
      email: { unique: true },
      team: {},
    });

    const byEmail: Row<Member> | null = await members.findBy("email", "a@b.com");
    const byTeam = await members.listBy("team", "core");
    assertEquals(byEmail, null);
    assertEquals(byTeam.rows, []);

    // @ts-expect-error `team` is not unique, so a single row would be arbitrary.
    await members.findBy("team", "core");

    // @ts-expect-error `name` is not indexed.
    await members.listBy("name", "Alberto");

    // @ts-expect-error the value must match the field's type.
    await members.findBy("email", 42);
  });
});

Deno.test("only required fields of an indexable type can be indexed", async () => {
  await withKv((kv) => {
    interface Member {
      email: string;
      age?: number;
      tags: string[];
    }

    table<Member>(kv, "ok").withIndexes({ email: { unique: true } });

    // @ts-expect-error `age` is optional, so some rows would be missing from the index.
    table<Member>(kv, "bad").withIndexes({ age: {} });

    // @ts-expect-error `tags` is an array, which KV cannot use as a key part.
    table<Member>(kv, "bad").withIndexes({ tags: {} });

    // @ts-expect-error `nope` is not a field of Member.
    table<Member>(kv, "bad").withIndexes({ nope: {} });

    return Promise.resolve();
  });
});

Deno.test("indexes are declared with withIndexes, not in the options", async () => {
  await withKv((kv) => {
    interface Member {
      email: string;
      name: string;
    }

    table<Member>(kv, "fine", { prefix: ["x"] });

    table<Member>(kv, "fine", {
      // @ts-expect-error indexes belong to withIndexes.
      indexes: { email: { unique: true } },
    });

    return Promise.resolve();
  });
});
