const dropDependentConstraints = async (pool, constraintName) => {
  const dependents = await pool.query(
    `
    SELECT
      dependent_ns.nspname AS schema_name,
      dependent_table.relname AS table_name,
      dependent_constraint.conname AS constraint_name
    FROM pg_depend dependency
    JOIN pg_constraint source_constraint
      ON source_constraint.oid = dependency.refobjid
      OR source_constraint.conindid = dependency.refobjid
    JOIN pg_constraint dependent_constraint
      ON dependent_constraint.oid = dependency.objid
    JOIN pg_class dependent_table
      ON dependent_table.oid = dependent_constraint.conrelid
    JOIN pg_namespace dependent_ns
      ON dependent_ns.oid = dependent_table.relnamespace
    WHERE source_constraint.conname = $1
      AND dependency.deptype = 'n'
    `,
    [constraintName],
  );

  for (const row of dependents.rows) {
    await pool.query(
      `
      ALTER TABLE ${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.table_name)}
      DROP CONSTRAINT IF EXISTS ${quoteIdentifier(row.constraint_name)}
      `,
    );
  }
};

const dropConstraintWithDependents = async (pool, tableName, constraintName) => {
  await dropDependentConstraints(pool, constraintName);
  await pool.query(
    `
    ALTER TABLE ${quoteIdentifier(tableName)}
    DROP CONSTRAINT IF EXISTS ${quoteIdentifier(constraintName)}
    `,
  );
};

const quoteIdentifier = (value) => `"${String(value).replace(/"/g, '""')}"`;

module.exports = {
  dropConstraintWithDependents,
};
