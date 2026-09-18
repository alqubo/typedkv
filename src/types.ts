export type ReservedField = "id" | "createdAt" | "updatedAt" | "versionstamp";
export type TableType = object & Partial<Record<ReservedField, never>>;

export type Row<T> = T & {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly versionstamp: string;
};

export interface StoredRow<T> {
  _v: number;
  id: string;
  createdAt: Date;
  updatedAt: Date;
  data: T;
}

export type Validator<T> = (value: unknown) => value is T;

export interface TableOptions<T> {
  validate?: Validator<T>;
}

export interface ListOptions {
  cursor?: string;
  limit?: number;
  reverse?: boolean;
}

export interface ListResult<T> {
  rows: Row<T>[];
  cursor: string;
}

export interface VersionCheck {
  versionstamp?: string | null;
}

export interface Table<T> {
  readonly name: string;

  /**
   * Creates a row with a generated id with a key you do not choose.
   * Fails with `ConflictError` if that id somehow already exists.
   */
  set(value: T): Promise<Row<T>>;

  /**
   * Writes the row under `id`, creating it or replacing it whole.
   * Fields left out of `value` are dropped; use `update` for a partial change.
   * `createdAt` is kept when the row already existed.
   */
  set(id: string, value: T, options?: VersionCheck): Promise<Row<T>>;

  /** Returns the row, or `null` when it does not exist. */
  get(id: string): Promise<Row<T> | null>;

  /** Applies a partial change. `createdAt` is kept; `updatedAt` is refreshed. */
  update(id: string, patch: Partial<T>, options?: VersionCheck): Promise<Row<T>>;

  /** Deletes the row. Throws `NotFoundError` when it does not exist. */
  delete(id: string, options?: VersionCheck): Promise<void>;

  /** Walks the table in insertion order. */
  list(options?: ListOptions): Promise<ListResult<T>>;
}
