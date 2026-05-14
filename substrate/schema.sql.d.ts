// Ambient declaration so `import schemaSql from './schema.sql' with { type: 'text' }`
// typechecks under tsc. At runtime Bun resolves the import via the import
// attribute and hands back the file contents as a string.
declare const schemaSql: string;
export default schemaSql;
