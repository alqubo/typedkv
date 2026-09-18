import {
  ConflictError,
  NotFoundError,
  table,
  UniqueConstraintError,
  ValidationError,
} from "./src/mod.ts";

const kv = await Deno.openKv(":memory:");

const log = (title: string, value?: unknown) => {
  console.log(`\n%c${title}`, "font-weight: bold");
  if (value !== undefined) console.log(value);
};

interface User {
  email: string;
  team: string;
  name: string;
  age?: number;
}

const users = table<User>(kv, "users", {
  validate: (v): v is User =>
    typeof v === "object" && v !== null &&
    typeof (v as User).email === "string" &&
    typeof (v as User).team === "string" &&
    typeof (v as User).name === "string",
}).withIndexes({ email: { unique: true }, team: {} });

const user = await users.set({ email: "user@example.com", team: "core", name: "User", age: 30 });
log("set", user);

log("get", await users.get(user.id));

const updated = await users.update(user.id, { name: "User Edited." });
log("partial update (createdAt kept, updatedAt refreshed)", {
  createdAt: updated.createdAt,
  updatedAt: updated.updatedAt,
  name: updated.name,
  email: updated.email,
});

// await users.set({ email: "c@d.com", team: "ops", name: "Carla" });
// await users.set({ email: "e@f.com", team: "core", name: "Eva" });

const page = await users.list({ limit: 2 });
log("list ({ limit: 2 }) in insertion order", {
  rows: page.rows.map((r) => r.name),
  hasMore: page.cursor !== "",
});
log("list (next page)", (await users.list({ cursor: page.cursor })).rows.map((r) => r.name));

try {
  await users.update(user.id, { age: 31 }, { versionstamp: user.versionstamp });
} catch (error) {
  if (!(error instanceof ConflictError)) throw error;
  log("ConflictError", { message: error.message, expected: error.expected, actual: error.actual });
}

try {
  await users.set({ email: 42, team: "core", name: "Bad" } as unknown as User);
} catch (error) {
  if (!(error instanceof ValidationError)) throw error;
  log("ValidationError", { message: error.message, value: error.value });
}

log("findBy (unique index)", await users.findBy("email", "user@example.com"));
log(
  "listBy (non-unique index)",
  (await users.listBy("team", "core")).rows.map((r) => r.name),
);

try {
  await users.set({ email: "c@d.com", team: "core", name: "Impostor" });
} catch (error) {
  if (!(error instanceof UniqueConstraintError)) throw error;
  log("UniqueConstraintError", {
    message: error.message,
    field: error.field,
    value: error.value,
    owner: error.owner,
  });
}

try {
  await users.delete("01JZZZZZZZZZZZZZZZZZZZZZZZ");
} catch (error) {
  if (!(error instanceof NotFoundError)) throw error;
  log("NotFoundError", error.message);
}

// await users.delete(user.id);

log("raw keys in KV");
for await (const entry of kv.list({ prefix: ["tables"] })) {
  console.log(entry.key, entry.value);
}

kv.close();
