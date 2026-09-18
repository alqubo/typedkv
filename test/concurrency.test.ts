import { assert, assertEquals, assertRejects } from "@std/assert";
import { ConflictError, table, UniqueConstraintError } from "../src/mod.ts";
import { withKv, withUsers } from "./helpers.ts";

Deno.test("update with a stale versionstamp throws ConflictError", async () => {
  await withUsers(async (users) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto" });
    const updated = await users.update(user.id, { name: "Alberto G." });

    const error = await assertRejects(
      () => users.update(user.id, { name: "other" }, { versionstamp: user.versionstamp }),
      ConflictError,
    );
    assertEquals(error.expected, user.versionstamp);
    assertEquals(error.actual, updated.versionstamp);

    assertEquals((await users.get(user.id))!.name, "Alberto G.", "the row was left untouched");
  });
});

Deno.test("update with the current versionstamp succeeds", async () => {
  await withUsers(async (users) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto" });
    const updated = await users.update(user.id, { name: "Alberto G." }, {
      versionstamp: user.versionstamp,
    });
    assertEquals(updated.name, "Alberto G.");
  });
});

Deno.test("delete with a stale versionstamp throws ConflictError and keeps the row", async () => {
  await withUsers(async (users) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto" });
    await users.update(user.id, { name: "Alberto G." });

    await assertRejects(
      () => users.delete(user.id, { versionstamp: user.versionstamp }),
      ConflictError,
    );
    assert(await users.get(user.id) !== null);
  });
});

function kvWithInterleavedWrite(kv: Deno.Kv, write: () => Promise<unknown>): Deno.Kv {
  let done = false;
  return {
    get: async (key: Deno.KvKey) => {
      const entry = await kv.get(key);
      if (!done) {
        done = true;
        await write();
      }
      return entry;
    },
    getMany: async (batch: Deno.KvKey[]) => {
      const entries = await kv.getMany(batch);
      if (!done) {
        done = true;
        await write();
      }
      return entries;
    },
    atomic: () => kv.atomic(),
    list: (selector: Deno.KvListSelector, options?: Deno.KvListOptions) =>
      kv.list(selector, options),
  } as unknown as Deno.Kv;
}

Deno.test("update fails when the row changes between the read and the commit", async () => {
  await withUsers(async (users, kv) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto" });
    const race = table<{ email: string; name: string; age?: number }>(
      kvWithInterleavedWrite(kv, () => users.update(user.id, { name: "the other one wins" })),
      "users",
    );

    await assertRejects(() => race.update(user.id, { name: "i lose" }), ConflictError);
    assertEquals((await users.get(user.id))!.name, "the other one wins");
  });
});

Deno.test("delete fails when the row changes between the read and the commit", async () => {
  await withUsers(async (users, kv) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto" });
    const race = table<{ email: string; name: string; age?: number }>(
      kvWithInterleavedWrite(kv, () => users.update(user.id, { name: "the other one wins" })),
      "users",
    );

    await assertRejects(() => race.delete(user.id), ConflictError);
    assert(await users.get(user.id) !== null, "the row is still there");
  });
});

Deno.test("sequential updates on the same row chain versionstamps", async () => {
  await withUsers(async (users) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto" });

    let current = user;
    for (let i = 1; i <= 5; i++) {
      current = await users.update(current.id, { age: i }, { versionstamp: current.versionstamp });
      assertEquals(current.age, i);
    }
    assertEquals((await users.get(user.id))!.age, 5);
  });
});

Deno.test("a unique index survives two writers racing for the same value", async () => {
  await withKv(async (kv) => {
    interface Member {
      email: string;
      name: string;
    }
    const members = table<Member>(kv, "members").withIndexes({ email: { unique: true } });
    const race = table<Member>(
      kvWithInterleavedWrite(kv, () => members.set({ email: "a@b.com", name: "Winner" })),
      "members",
    ).withIndexes({ email: { unique: true } });

    const error = await assertRejects(
      () => race.set({ email: "a@b.com", name: "Loser" }),
      UniqueConstraintError,
    );
    assertEquals(error.field, "email");

    const rows = (await members.list()).rows;
    assertEquals(rows.map((r) => r.name), ["Winner"], "only one row made it");
    assertEquals((await members.findBy("email", "a@b.com"))!.name, "Winner");
  });
});
