export const DEFAULT_PREFIX: Deno.KvKey = ["tables"];

export function byId(prefix: Deno.KvKey, table: string, id: string): Deno.KvKey {
  return [...prefix, table, "by_id", id];
}

export function byIdPrefix(prefix: Deno.KvKey, table: string): Deno.KvKey {
  return [...prefix, table, "by_id"];
}

export function byIndex(
  prefix: Deno.KvKey,
  table: string,
  field: string,
  value: Deno.KvKeyPart,
  id?: string,
): Deno.KvKey {
  const key: Deno.KvKey = [...prefix, table, `by_${field}`, value];
  return id === undefined ? key : [...key, id];
}

export function byIndexPrefix(
  prefix: Deno.KvKey,
  table: string,
  field: string,
  value: Deno.KvKeyPart,
): Deno.KvKey {
  return [...prefix, table, `by_${field}`, value];
}
