export const ROOT = "tables";

export function byId(table: string, id: string): Deno.KvKey {
  return [ROOT, table, "by_id", id];
}

export function byIdPrefix(table: string): Deno.KvKey {
  return [ROOT, table, "by_id"];
}
