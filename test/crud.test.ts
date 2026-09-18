import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { ConflictError, NotFoundError, table } from "../src/mod.ts";
import { sleep, withUsers } from "./helpers.ts";

Deno.test("set returns the row with its managed fields", async () => {
  await withUsers(async (users) => {
    const before = Date.now();
    const user = await users.set({ email: "a@b.com", name: "Alberto" });

    assertEquals(user.email, "a@b.com");
    assertEquals(user.name, "Alberto");
    assertEquals(user.id.length, 26, "the id is a ULID");
    assertInstanceOf(user.createdAt, Date);
    assertEquals(user.createdAt.getTime(), user.updatedAt.getTime());
    assert(user.createdAt.getTime() >= before);
    assert(user.versionstamp.length > 0);
  });
});

Deno.test("get returns the stored row, or null when it does not exist", async () => {
  await withUsers(async (users) => {
    const created = await users.set({ email: "a@b.com", name: "Alberto", age: 30 });
    const found = await users.get(created.id);

    assertEquals(found, created);
    assertEquals(await users.get("01JZZZZZZZZZZZZZZZZZZZZZZZ"), null);
  });
});

Deno.test("update applies a partial change and keeps createdAt", async () => {
  await withUsers(async (users) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto", age: 30 });
    await sleep(2);
    const updated = await users.update(user.id, { name: "Alberto G." });

    assertEquals(updated.id, user.id);
    assertEquals(updated.name, "Alberto G.");
    assertEquals(updated.email, "a@b.com", "untouched fields are kept");
    assertEquals(updated.age, 30);
    assertEquals(updated.createdAt.getTime(), user.createdAt.getTime());
    assert(updated.updatedAt.getTime() > user.updatedAt.getTime());
    assert(updated.versionstamp !== user.versionstamp);

    assertEquals(await users.get(user.id), updated, "the change is persisted");
  });
});

Deno.test("update and delete fail with NotFoundError when the row does not exist", async () => {
  await withUsers(async (users) => {
    const id = "01JZZZZZZZZZZZZZZZZZZZZZZZ";
    await assertRejects(() => users.update(id, { name: "x" }), NotFoundError);
    await assertRejects(() => users.delete(id), NotFoundError);
  });
});

Deno.test("delete removes the row and is not idempotent", async () => {
  await withUsers(async (users) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto" });
    await users.delete(user.id);

    assertEquals(await users.get(user.id), null);
    assertEquals((await users.list()).rows, []);
    await assertRejects(() => users.delete(user.id), NotFoundError);
  });
});

Deno.test("list returns the rows in insertion order", async () => {
  await withUsers(async (users) => {
    const names = ["a", "b", "c"];
    for (const name of names) {
      await users.set({ email: `${name}@b.com`, name });
    }

    const { rows } = await users.list();
    assertEquals(rows.map((r) => r.name), names);

    const reversed = await users.list({ reverse: true });
    assertEquals(reversed.rows.map((r) => r.name), [...names].reverse());
  });
});

Deno.test("list paginates with cursor and limit", async () => {
  await withUsers(async (users) => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      await users.set({ email: `${name}@b.com`, name });
    }

    const first = await users.list({ limit: 2 });
    assertEquals(first.rows.map((r) => r.name), ["a", "b"]);
    assert(first.cursor.length > 0);

    const second = await users.list({ limit: 2, cursor: first.cursor });
    assertEquals(second.rows.map((r) => r.name), ["c", "d"]);

    const third = await users.list({ limit: 2, cursor: second.cursor });
    assertEquals(third.rows.map((r) => r.name), ["e"]);
    assertEquals(third.cursor, "", "no more pages means an empty cursor");
  });
});

Deno.test("tables are isolated from each other", async () => {
  await withUsers(async (users, kv) => {
    const admins = table<{ email: string; name: string }>(kv, "admins");

    await users.set({ email: "a@b.com", name: "Alberto" });
    await admins.set({ email: "c@d.com", name: "Carla" });

    assertEquals((await users.list()).rows.length, 1);
    assertEquals((await admins.list()).rows.length, 1);
    assertEquals((await users.list()).rows[0].name, "Alberto");
  });
});

Deno.test("set(id, value) creates the row under that id when it does not exist", async () => {
  await withUsers(async (users) => {
    const row = await users.set("u_123", { email: "a@b.com", name: "Alberto" });

    assertEquals(row.id, "u_123");
    assertEquals(row.createdAt.getTime(), row.updatedAt.getTime());
    assertEquals(await users.get("u_123"), row);
  });
});

Deno.test("set(id, value) replaces the whole row and keeps createdAt", async () => {
  await withUsers(async (users) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto", age: 30 });
    await sleep(2);
    const replaced = await users.set(user.id, { email: "c@d.com", name: "Carla" });

    assertEquals(replaced.id, user.id);
    assertEquals(replaced.email, "c@d.com");
    assertEquals(replaced.age, undefined, "fields left out are dropped, unlike update");
    assertEquals(replaced.createdAt.getTime(), user.createdAt.getTime());
    assert(replaced.updatedAt.getTime() > user.updatedAt.getTime());
    assertEquals((await users.list()).rows.length, 1);
  });
});

Deno.test("set(id, value) honours a versionstamp check", async () => {
  await withUsers(async (users) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto" });
    const updated = await users.update(user.id, { name: "Alberto G." });

    const stale = await assertRejects(
      () =>
        users.set(user.id, { email: "x@y.com", name: "X" }, {
          versionstamp: user.versionstamp,
        }),
      ConflictError,
    );
    assertEquals(stale.actual, updated.versionstamp);

    const ok = await users.set(user.id, { email: "x@y.com", name: "X" }, {
      versionstamp: updated.versionstamp,
    });
    assertEquals(ok.email, "x@y.com");
  });
});

Deno.test("set(id, value) with versionstamp null only creates when absent", async () => {
  await withUsers(async (users) => {
    const row = await users.set("u_1", { email: "a@b.com", name: "Alberto" }, {
      versionstamp: null,
    });
    assertEquals(row.id, "u_1");

    const error = await assertRejects(
      () => users.set("u_1", { email: "c@d.com", name: "Carla" }, { versionstamp: null }),
      ConflictError,
    );
    assertEquals(error.expected, null);
    assertEquals(error.actual, row.versionstamp);
    assertEquals((await users.get("u_1"))!.name, "Alberto");
  });
});
