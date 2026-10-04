/** The command line was used incorrectly. Exit code 2. */
export class UsageError extends Error {}

/** The start URL could not be audited. Exit code 3. */
export class UnreachableError extends Error {}
