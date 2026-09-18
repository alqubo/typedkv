export class TypedKvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends TypedKvError {
  constructor(readonly table: string, readonly value: unknown) {
    super(`Value is not valid for table "${table}".`);
  }
}

export class NotFoundError extends TypedKvError {
  constructor(readonly table: string, readonly id: string) {
    super(`Row "${id}" does not exist in table "${table}".`);
  }
}

export class ConflictError extends TypedKvError {
  constructor(
    readonly table: string,
    readonly id: string,
    readonly expected?: string | null,
    readonly actual?: string | null,
  ) {
    super(
      `Concurrency conflict on "${table}" / "${id}"` +
        (expected === undefined
          ? "."
          : `: expected versionstamp ${expected ?? "null"} but the current one is ${
            actual ?? "null"
          }.`),
    );
  }
}

export class UniqueConstraintError extends TypedKvError {
  constructor(
    readonly table: string,
    readonly field: string,
    readonly value: unknown,
    readonly owner: string,
  ) {
    super(
      `Value ${
        JSON.stringify(value)
      } is already taken in unique index "${field}" of table "${table}".`,
    );
  }
}
