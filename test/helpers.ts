import { table } from "../src/mod.ts";
import type { Table } from "../src/mod.ts";

export interface User {
  email: string;
  name: string;
  age?: number;
}

export const isUser = (v: unknown): v is User =>
  typeof v === "object" && v !== null &&
  typeof (v as User).email === "string" &&
  typeof (v as User).name === "string";

export async function withKv(fn: (kv: Deno.Kv) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

export async function withUsers(
  fn: (users: Table<User>, kv: Deno.Kv) => Promise<void>,
  validate = false,
): Promise<void> {
  await withKv(async (kv) => {
    await fn(table<User>(kv, "users", validate ? { validate: isUser } : {}), kv);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
