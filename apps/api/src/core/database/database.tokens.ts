/**
 * Injection token for the Drizzle client, in its own file so the module and the
 * service that consumes it do not import each other.
 */
export const DB_CLIENT = Symbol("DB_CLIENT");
