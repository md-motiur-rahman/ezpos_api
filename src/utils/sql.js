import { query } from '../db/pool.js';

/**
 * Builds a parameterized SQL SET clause from only the fields actually
 * present in `data` - the core of every partial UPDATE in this project.
 *
 * fieldMap maps camelCase JS keys to snake_case DB columns, e.g.
 *   { addressLine1: 'address_line1', vatRegistered: 'vat_registered' }
 *
 * Always appends `updated_at = now()`. Returns { clause, values } - the
 * caller pushes their WHERE-clause value(s) onto `values` afterward and
 * uses values.length for the next placeholder index.
 *
 * Usage:
 *   const { clause, values } = buildUpdateSet(fieldMap, data);
 *   values.push(id);
 *   query(`UPDATE shops SET ${clause} WHERE id = $${values.length}`, values);
 */
export function buildUpdateSet(fieldMap, data) {
  const setClauses = [];
  const values = [];

  for (const [key, column] of Object.entries(fieldMap)) {
    if (data[key] !== undefined) {
      values.push(data[key]);
      setClauses.push(`${column} = $${values.length}`);
    }
  }
  setClauses.push('updated_at = now()');

  return { clause: setClauses.join(', '), values };
}

/**
 * Generic attach for a two-column many-to-many join table (id, two FK
 * columns, created_at). Used for every "attach X to Y" relationship in this
 * project - modifier groups to items (6.4), ingredients to items (6.5) -
 * rather than a near-identical INSERT written per relationship.
 *
 * table/columnA/columnB are always hardcoded string literals passed by
 * trusted internal code, never user input - same trust boundary already
 * relied on throughout this project's raw-SQL repositories (e.g. every
 * COLUMNS constant, buildUpdateSet's fieldMap keys). Postgres can't
 * parameterize identifiers via $N placeholders, only values.
 *
 * Throws Postgres unique-violation (23505) if the pair is already attached -
 * the caller's service layer catches this and turns it into a 409.
 */
export async function attachRelationship(table, columnA, valueA, columnB, valueB) {
  const { rows } = await query(
    `INSERT INTO ${table} (${columnA}, ${columnB})
     VALUES ($1, $2)
     RETURNING id, ${columnA}, ${columnB}, created_at`,
    [valueA, valueB]
  );
  return rows[0];
}

export async function detachRelationship(table, columnA, valueA, columnB, valueB) {
  const { rows } = await query(
    `DELETE FROM ${table}
     WHERE ${columnA} = $1 AND ${columnB} = $2
     RETURNING id`,
    [valueA, valueB]
  );
  return rows[0] ?? null;
}

/**
 * Same as attachRelationship, but for join tables that also carry one
 * mutable data column beyond the two FK columns - shared by all three
 * recipe-ingredient relationships in 7.2 (item, variant, and modifier
 * option recipes) rather than three near-identical INSERTs. Deliberately a
 * separate function from attachRelationship rather than an optional-extra-
 * columns parameter on it - keeps the existing simple callers (6.4's
 * modifier group attachment, which has no extra data) untouched and simple,
 * rather than adding complexity they don't need.
 *
 * Throws Postgres unique-violation (23505) if the pair is already attached,
 * same as attachRelationship - adjusting an existing attachment's quantity
 * is updateRelationshipQuantity's job, not this one's.
 */
export async function attachRelationshipWithQuantity(table, columnA, valueA, columnB, valueB, quantity) {
  const { rows } = await query(
    `INSERT INTO ${table} (${columnA}, ${columnB}, quantity)
     VALUES ($1, $2, $3)
     RETURNING id, ${columnA}, ${columnB}, quantity, created_at, updated_at`,
    [valueA, valueB, quantity]
  );
  return rows[0];
}

/** Adjusts just the quantity of an already-attached relationship, without detaching and reattaching. */
export async function updateRelationshipQuantity(table, columnA, valueA, columnB, valueB, quantity) {
  const { rows } = await query(
    `UPDATE ${table} SET quantity = $3, updated_at = now()
     WHERE ${columnA} = $1 AND ${columnB} = $2
     RETURNING id, ${columnA}, ${columnB}, quantity, created_at, updated_at`,
    [valueA, valueB, quantity]
  );
  return rows[0] ?? null;
}