import { ConflictError, NotFoundError, table, ValidationError } from "./src/mod.ts";

const kv = await Deno.openKv(":memory:");

const log = (title: string, value?: unknown) => {
  console.log(`\n%c${title}`, "font-weight: bold");
  if (value !== undefined) console.log(value);
};

interface User {
  email: string;
  name: string;
  age?: number;
}

const users = table<User>(kv, "users", {
  validate: (v): v is User =>
    typeof v === "object" && v !== null &&
    typeof (v as User).email === "string" &&
    typeof (v as User).name === "string",
});

const alberto = await users.set({ email: "a@b.com", name: "Alberto", age: 30 });
log("set", alberto);

log("get", await users.get(alberto.id));

const updated = await users.update(alberto.id, { name: "Alberto G." });
log("partial update (createdAt kept, updatedAt refreshed)", {
  createdAt: updated.createdAt,
  updatedAt: updated.updatedAt,
  name: updated.name,
  email: updated.email,
});

await users.set({ email: "c@d.com", name: "Carla" });
await users.set({ email: "e@f.com", name: "Eva" });

const page = await users.list({ limit: 2 });
log("list ({ limit: 2 }) in insertion order", {
  rows: page.rows.map((r) => r.name),
  hasMore: page.cursor !== "",
});
log("list (next page)", (await users.list({ cursor: page.cursor })).rows.map((r) => r.name));

try {
  await users.update(alberto.id, { age: 31 }, { versionstamp: alberto.versionstamp });
} catch (error) {
  if (!(error instanceof ConflictError)) throw error;
  log("ConflictError", { message: error.message, expected: error.expected, actual: error.actual });
}

try {
  await users.set({ email: 42, name: "Bad" } as unknown as User);
} catch (error) {
  if (!(error instanceof ValidationError)) throw error;
  log("ValidationError", { message: error.message, value: error.value });
}

try {
  await users.delete("01JZZZZZZZZZZZZZZZZZZZZZZZ");
} catch (error) {
  if (!(error instanceof NotFoundError)) throw error;
  log("NotFoundError", error.message);
}

log("raw keys in KV");
for await (const entry of kv.list({ prefix: ["tables"] })) {
  console.log(entry.key, entry.value);
}

kv.close();
