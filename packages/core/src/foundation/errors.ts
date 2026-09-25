/**
 * Error hierarchy for Kitabu.
 *
 * Rule (docs/UX.md §5): users see friendly `userMessage`; technical detail stays in
 * logs. Services throw KitabuError with a stable `code`.
 */

export type KitabuErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'DOMAIN_RULE'
  | 'PERMISSION'
  | 'CONFLICT'
  | 'SCHEMA'
  | 'NESTED_TRANSACTION'
  | 'STORAGE'
  | 'NOT_BOOTSTRAPPED';

export class KitabuError extends Error {
  readonly code: KitabuErrorCode;
  readonly userMessage: string;
  readonly technical?: string;

  constructor(code: KitabuErrorCode, userMessage: string, technical?: string) {
    super(userMessage);
    this.name = 'KitabuError';
    this.code = code;
    this.userMessage = userMessage;
    this.technical = technical;
  }
}

export function validationError(userMessage: string, technical?: string): KitabuError {
  return new KitabuError('VALIDATION', userMessage, technical);
}

export function notFound(userMessage: string, technical?: string): KitabuError {
  return new KitabuError('NOT_FOUND', userMessage, technical);
}

export function domainRule(userMessage: string, technical?: string): KitabuError {
  return new KitabuError('DOMAIN_RULE', userMessage, technical);
}

export function permissionError(userMessage: string, technical?: string): KitabuError {
  return new KitabuError('PERMISSION', userMessage, technical);
}

/**
 * Map raw SQLite constraint violations to friendly messages. This is the backstop —
 * services are expected to validate first with better context (docs/DATABASE.md).
 */
export function friendlyStorageError(err: unknown): KitabuError {
  const message = err instanceof Error ? err.message : String(err);
  // node:sqlite reports partial unique-index violations by column list
  // (e.g. "UNIQUE constraint failed: tenancies.unit_id"); the sqlite3 CLI uses the
  // index-name form. Both are matched.
  const map: ReadonlyArray<readonly [RegExp, string]> = [
    [/UNIQUE constraint failed: .*units\..*label/i,
      'A house with this number already exists in this property.'],
    [/UNIQUE constraint failed: .*tenancies\./i,
      'This house already has a tenant. End the current tenancy first.'],
    [/UNIQUE constraint failed: .*rent_rates/i,
      'A rent rate already exists for this date.'],
    [/FOREIGN KEY constraint failed/i,
      'This record is linked to another record that does not exist or is protected.'],
  ];
  for (const [re, friendly] of map) {
    if (re.test(message)) return new KitabuError('DOMAIN_RULE', friendly, message);
  }
  return new KitabuError('STORAGE', 'Something went wrong while saving. Your data is safe — please try again.', message);
}
