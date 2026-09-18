import { assertEquals, assertRejects } from "@std/assert";
import { ValidationError } from "../src/mod.ts";
import { withUsers } from "./helpers.ts";

Deno.test("set rejects a value that does not pass the validator", async () => {
  await withUsers(async (users) => {
    const bad = { email: 42, name: "Alberto" } as unknown as { email: string; name: string };

    const error = await assertRejects(() => users.set(bad), ValidationError);
    assertEquals(error.table, "users");
    assertEquals(error.value, bad);
    assertEquals((await users.list()).rows, [], "nothing was written");
  }, true);
});

Deno.test("update rejects the patch when the result does not pass the validator", async () => {
  await withUsers(async (users) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto" });
    const patch = { email: null } as unknown as { email: string };

    await assertRejects(() => users.update(user.id, patch), ValidationError);
    assertEquals((await users.get(user.id))!.email, "a@b.com", "the row did not change");
  }, true);
});

Deno.test("without a validator nothing is checked at runtime", async () => {
  await withUsers(async (users) => {
    const bad = { email: 42, name: "Alberto" } as unknown as { email: string; name: string };
    const row = await users.set(bad);
    assertEquals(row.email as unknown, 42);
  });
});

Deno.test("the validator sees the whole value, not just the patch", async () => {
  await withUsers(async (users) => {
    const user = await users.set({ email: "a@b.com", name: "Alberto" });
    const updated = await users.update(user.id, { age: 31 });
    assertEquals(updated.age, 31);
    assertEquals(updated.email, "a@b.com");
  }, true);
});
