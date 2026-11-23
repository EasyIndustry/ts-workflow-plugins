/**
 * El SQL del plugin. Es texto fijo: nada de lo que llega de una definición o de un usuario se concatena acá. Los
 * identificadores se validan contra `flujo.permitidos` adentro de la base y se citan con `format('%I')`.
 *
 * Roles: `flujo_ddl` (sin login) es dueño de todo. La API no tiene DDL: solo puede ejecutar `flujo.reconciliar`, que
 * corre como `flujo_ddl` y únicamente toca lo que un administrador permitió con `flujo.permitir`.
 */
export declare const CANAL = "flujo_outbox";
export declare const SQL_INSTALACION: string;
