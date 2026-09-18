import { assert, assertEquals } from "@std/assert";
import { table } from "../src/mod.ts";
import { withKv } from "./helpers.ts";

interface Thing {
  code: string;
  name: string;
}

Deno.test("every key lives under the default prefix", async () => {
  await withKv(async (kv) => {
    const things = table<Thing>(kv, "things").withIndexes({ code: { unique: true } });
    await things.set({ code: "x", name: "Thing" });

    const roots = new Set<unknown>();
    for await (const entry of kv.list({ prefix: [] })) roots.add(entry.key[0]);
    assertEquals([...roots], ["tables"]);
  });
});

Deno.test("a custom prefix moves every key, index entries included", async () => {
  await withKv(async (kv) => {
    const things = table<Thing>(kv, "things", { prefix: ["myapp", "v1"] })
      .withIndexes({ code: { unique: true }, name: {} });
    const thing = await things.set({ code: "x", name: "Thing" });

    const keys: Deno.KvKey[] = [];
    for await (const entry of kv.list({ prefix: [] })) keys.push(entry.key);

    assertEquals(keys.length, 3, "row plus two index entries");
    assert(keys.every((key) => key[0] === "myapp" && key[1] === "v1"));

    assertEquals((await things.get(thing.id))!.code, "x");
    assertEquals((await things.findBy("code", "x"))!.id, thing.id);
    assertEquals((await things.listBy("name", "Thing")).rows.length, 1);
    assertEquals((await things.list()).rows.length, 1);
  });
});

Deno.test("the same table name under two prefixes stays isolated", async () => {
  await withKv(async (kv) => {
    const tenantA = table<Thing>(kv, "things", { prefix: ["a"] })
      .withIndexes({ code: { unique: true } });
    const tenantB = table<Thing>(kv, "things", { prefix: ["b"] })
      .withIndexes({ code: { unique: true } });

    await tenantA.set({ code: "x", name: "From A" });
    await tenantB.set({ code: "x", name: "From B" });

    assertEquals((await tenantA.findBy("code", "x"))!.name, "From A");
    assertEquals((await tenantB.findBy("code", "x"))!.name, "From B");
    assertEquals((await tenantA.list()).rows.length, 1);
  });
});

Deno.test("an empty prefix puts the table at the root of the KV", async () => {
  await withKv(async (kv) => {
    const things = table<Thing>(kv, "things", { prefix: [] });
    const thing = await things.set({ code: "x", name: "Thing" });

    const entry = await kv.get(["things", "by_id", thing.id]);
    assert(entry.value !== null, "the row sits right under the table name");
  });
});

Deno.test("a custom prefix does not clash with your own keys", async () => {
  await withKv(async (kv) => {
    await kv.set(["things", "config"], { mine: true });

    const things = table<Thing>(kv, "things");
    await things.set({ code: "x", name: "Thing" });

    const mine = await kv.get<{ mine: boolean }>(["things", "config"]);
    assertEquals(mine.value, { mine: true }, "your key is untouched");
    assertEquals((await things.list()).rows.length, 1);
  });
});
