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