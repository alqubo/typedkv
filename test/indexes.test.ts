import { assert, assertEquals, assertRejects } from "@std/assert";
import { table, UniqueConstraintError } from "../src/mod.ts";
import { withKv, withMembers } from "./helpers.ts";

Deno.test("findBy resolves a row through a unique index", async () => {
  await withMembers(async (members) => {
    const created = await members.set({ email: "a@b.com", team: "core", name: "Alberto" });

    assertEquals(await members.findBy("email", "a@b.com"), created);
    assertEquals(await members.findBy("email", "missing@b.com"), null);
  });
});

Deno.test("listBy returns every row holding that value, in insertion order", async () => {
  await withMembers(async (members) => {
    await members.set({ email: "a@b.com", team: "core", name: "Alberto" });
    await members.set({ email: "c@d.com", team: "ops", name: "Carla" });
    await members.set({ email: "e@f.com", team: "core", name: "Eva" });

    const core = await members.listBy("team", "core");
    assertEquals(core.rows.map((r) => r.name), ["Alberto", "Eva"]);

    const ops = await members.listBy("team", "ops");
    assertEquals(ops.rows.map((r) => r.name), ["Carla"]);

    assertEquals((await members.listBy("team", "nope")).rows, []);
  });
});

Deno.test("listBy also works on a unique index", async () => {
  await withMembers(async (members) => {
    await members.set({ email: "a@b.com", team: "core", name: "Alberto" });

    const found = await members.listBy("email", "a@b.com");
    assertEquals(found.rows.map((r) => r.name), ["Alberto"]);
  });
});

Deno.test("a unique index rejects a second row with the same value", async () => {
  await withMembers(async (members) => {
    await members.set({ email: "a@b.com", team: "core", name: "Alberto" });

    const error = await assertRejects(
      () => members.set({ email: "a@b.com", team: "ops", name: "Impostor" }),
      UniqueConstraintError,
    );
    assertEquals(error.field, "email");
    assertEquals(error.value, "a@b.com");

    assertEquals((await members.list()).rows.length, 1, "the rejected row was not written");
    assertEquals((await members.listBy("team", "ops")).rows, [], "no index entry was left behind");
  });
});

Deno.test("update keeps the indexes consistent when the value changes", async () => {
  await withMembers(async (members) => {
    const member = await members.set({ email: "a@b.com", team: "core", name: "Alberto" });
    await members.update(member.id, { team: "ops", email: "new@b.com" });

    assertEquals((await members.listBy("team", "core")).rows, [], "the old entry is gone");
    assertEquals((await members.listBy("team", "ops")).rows.length, 1);
    assertEquals(await members.findBy("email", "a@b.com"), null);
    assertEquals((await members.findBy("email", "new@b.com"))!.id, member.id);
  });
});

Deno.test("updating a row to a value another row holds is rejected", async () => {
  await withMembers(async (members) => {
    await members.set({ email: "a@b.com", team: "core", name: "Alberto" });
    const carla = await members.set({ email: "c@d.com", team: "ops", name: "Carla" });

    await assertRejects(
      () => members.update(carla.id, { email: "a@b.com" }),
      UniqueConstraintError,
    );
    assertEquals((await members.findBy("email", "a@b.com"))!.name, "Alberto");
    assertEquals((await members.get(carla.id))!.email, "c@d.com");
  });
});

Deno.test("a row can keep its own value in a unique index across writes", async () => {
  await withMembers(async (members) => {
    const member = await members.set({ email: "a@b.com", team: "core", name: "Alberto" });

    const renamed = await members.update(member.id, { name: "Alberto G." });
    assertEquals(renamed.name, "Alberto G.");

    const replaced = await members.set(member.id, {
      email: "a@b.com",
      team: "ops",
      name: "Alberto G.",
    });
    assertEquals(replaced.team, "ops");
    assertEquals((await members.findBy("email", "a@b.com"))!.id, member.id);
  });
});

Deno.test("delete removes the row and every index entry", async () => {
  await withMembers(async (members, kv) => {
    const member = await members.set({ email: "a@b.com", team: "core", name: "Alberto" });
    await members.delete(member.id);

    assertEquals(await members.findBy("email", "a@b.com"), null);
    assertEquals((await members.listBy("team", "core")).rows, []);

    const left: Deno.KvKey[] = [];
    for await (const entry of kv.list({ prefix: ["tables", "members"] })) left.push(entry.key);
    assertEquals(left, [], "no key is left behind");

    await members.set({ email: "a@b.com", team: "core", name: "Someone else" });
  });
});

Deno.test("set(id, value) replacing a row drops the index entry of the old value", async () => {
  await withMembers(async (members) => {
    const member = await members.set({ email: "a@b.com", team: "core", name: "Alberto" });
    await members.set(member.id, { email: "new@b.com", team: "core", name: "Alberto" });

    assertEquals(await members.findBy("email", "a@b.com"), null);
    assertEquals((await members.findBy("email", "new@b.com"))!.id, member.id);
  });
});

Deno.test("indexes of different tables do not collide", async () => {
  await withKv(async (kv) => {
    interface Thing {
      code: string;
    }
    const a = table<Thing>(kv, "a").withIndexes({ code: { unique: true } });
    const b = table<Thing>(kv, "b").withIndexes({ code: { unique: true } });

    await a.set({ code: "x" });
    await b.set({ code: "x" });

    assert(await a.findBy("code", "x") !== null);
    assert(await b.findBy("code", "x") !== null);
  });
});

Deno.test("declaring more unique indexes than an atomic transaction allows fails", async () => {
  await withKv((kv) => {
    const fields = Array.from({ length: 100 }, (_, i) => `f${i}`);
    const indexes = Object.fromEntries(fields.map((f) => [f, { unique: true }]));
    type Wide = Record<string, string>;

    const error = (() => {
      try {
        table<Wide>(kv, "wide").withIndexes(indexes as never);
      } catch (e) {
        return e as Error;
      }
    })();

    assert(error instanceof TypeError, "declaring the table fails, not the first write");
    assert(error.message.includes("100 checks"));
    return Promise.resolve();
  });
});
