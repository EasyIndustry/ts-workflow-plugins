/**
 * El SQL del plugin. Es texto fijo: nada de lo que llega de una definición o de un usuario se concatena acá. Los
 * identificadores se validan contra `flujo.permitidos` adentro de la base y se citan con `format('%I')`.
 *
 * Roles: `flujo_ddl` (sin login) es dueño de todo. La API no tiene DDL: solo puede ejecutar `flujo.reconciliar`, que
 * corre como `flujo_ddl` y únicamente toca lo que un administrador permitió con `flujo.permitir`.
 */
export const CANAL = "flujo_outbox";
export const SQL_INSTALACION = String.raw `
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'flujo_ddl') THEN
    CREATE ROLE flujo_ddl NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $do$;
GRANT flujo_ddl TO CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS flujo AUTHORIZATION flujo_ddl;
REVOKE ALL ON SCHEMA flujo FROM PUBLIC;
SET LOCAL ROLE flujo_ddl;

CREATE TABLE IF NOT EXISTS flujo.permitidos (
  esquema text NOT NULL,
  tabla text NOT NULL,
  campos text[] NOT NULL,
  PRIMARY KEY (esquema, tabla)
);

CREATE TABLE IF NOT EXISTS flujo.suscripciones (
  clave text PRIMARY KEY,
  evento text NOT NULL,
  esquema text NOT NULL,
  tabla text NOT NULL,
  operacion text NOT NULL CHECK (operacion IN ('INSERT', 'UPDATE', 'DELETE')),
  campos text[],
  params jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS flujo.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  esquema text NOT NULL,
  tabla text NOT NULL,
  operacion text NOT NULL,
  pk jsonb NOT NULL,
  antes jsonb,
  despues jsonb,
  cambiados text[] NOT NULL DEFAULT '{}',
  cadena text,
  creado timestamptz NOT NULL DEFAULT now(),
  tomado_hasta timestamptz,
  intentos integer NOT NULL DEFAULT 0,
  procesado_en timestamptz,
  fallido_en timestamptz,
  error text
);
CREATE INDEX IF NOT EXISTS outbox_pendientes ON flujo.outbox (id) WHERE procesado_en IS NULL AND fallido_en IS NULL;

CREATE TABLE IF NOT EXISTS flujo.planes (clave text PRIMARY KEY, plan jsonb NOT NULL, creado timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS flujo.pasos (clave text PRIMARY KEY, hecho_en timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS flujo.fallidos (clave text PRIMARY KEY, datos jsonb NOT NULL, creado timestamptz NOT NULL DEFAULT now());

-- La única función de registro: la usan todos los triggers. Guarda solo la clave primaria y los campos permitidos.
CREATE OR REPLACE FUNCTION flujo.registrar() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  claves text[] := string_to_array(TG_ARGV[0], ',');
  campos text[] := string_to_array(TG_ARGV[1], ',');
  viejo jsonb;
  nuevo jsonb;
  cambiados text[] := '{}';
  id_fila jsonb;
  cadena text := nullif(current_setting('flujo.cadena', true), '');
BEGIN
  IF TG_OP <> 'INSERT' THEN viejo := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN nuevo := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT coalesce(array_agg(c ORDER BY c), '{}') INTO cambiados FROM unnest(campos) AS c WHERE (viejo -> c) IS DISTINCT FROM (nuevo -> c);
    IF cardinality(cambiados) = 0 THEN RETURN NULL; END IF;
  END IF;
  IF cadena IS NOT NULL AND cadena !~ '^[A-Za-z0-9:_.-]{1,200}\|[0-9]{1,4}$' THEN cadena := NULL; END IF;
  SELECT jsonb_object_agg(k, coalesce(nuevo, viejo) -> k) INTO id_fila FROM unnest(claves) AS k;
  INSERT INTO flujo.outbox (esquema, tabla, operacion, pk, antes, despues, cambiados, cadena)
  VALUES (
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, id_fila,
    (SELECT jsonb_object_agg(k, viejo -> k) FROM unnest(campos) AS k WHERE viejo IS NOT NULL),
    (SELECT jsonb_object_agg(k, nuevo -> k) FROM unnest(campos) AS k WHERE nuevo IS NOT NULL),
    cambiados, cadena
  );
  PERFORM pg_notify('flujo_outbox', '');
  RETURN NULL;
END $fn$;

-- Solo para un administrador: qué tablas y campos se pueden escuchar.
CREATE OR REPLACE FUNCTION flujo.permitir(p_tabla regclass, p_campos text[]) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  v_esquema text;
  v_tabla text;
  v_dueno name;
  v_super boolean;
  faltan text[];
BEGIN
  SELECT n.nspname, c.relname, r.rolname, r.rolsuper INTO v_esquema, v_tabla, v_dueno, v_super
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
  WHERE c.oid = p_tabla AND c.relkind IN ('r', 'p');
  IF v_tabla IS NULL THEN RAISE EXCEPTION 'flujo: % no es una tabla', p_tabla; END IF;
  IF v_esquema !~ '^[a-z_][a-z0-9_]{0,62}$' OR v_tabla !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'flujo: nombre de tabla no admitido: %.%', v_esquema, v_tabla;
  END IF;
  IF v_esquema IN ('flujo', 'pg_catalog', 'information_schema') THEN RAISE EXCEPTION 'flujo: no se puede escuchar el esquema %', v_esquema; END IF;
  IF v_super THEN
    RAISE EXCEPTION 'flujo: la tabla %.% es de un superusuario (%): pasala a un rol sin privilegios', v_esquema, v_tabla, v_dueno;
  END IF;
  IF p_campos IS NULL OR cardinality(p_campos) = 0 THEN RAISE EXCEPTION 'flujo: hay que permitir al menos un campo'; END IF;
  SELECT array_agg(c) INTO faltan FROM unnest(p_campos) AS c
  WHERE c !~ '^[a-z_][a-z0-9_]{0,62}$'
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = p_tabla AND a.attname = c AND a.attnum > 0 AND NOT a.attisdropped);
  IF faltan IS NOT NULL THEN RAISE EXCEPTION 'flujo: campos inválidos en %.%: %', v_esquema, v_tabla, faltan; END IF;
  -- Borrar un trigger exige ser dueño de la tabla: flujo_ddl hereda ese rol, que nunca es superusuario.
  EXECUTE format('GRANT %I TO flujo_ddl', v_dueno);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO flujo_ddl', v_esquema);
  INSERT INTO flujo.permitidos (esquema, tabla, campos)
  VALUES (v_esquema, v_tabla, (SELECT array_agg(DISTINCT c ORDER BY c) FROM unnest(p_campos) AS c))
  ON CONFLICT (esquema, tabla) DO UPDATE SET campos = excluded.campos;
END $fn$;

-- Deja los triggers exactamente como piden las suscripciones. Todo o nada, y con un tope de espera por los locks.
CREATE OR REPLACE FUNCTION flujo.reconciliar(deseados jsonb, vaciar boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '3s' AS $fn$
DECLARE
  x jsonb;
  g record;
  e record;
  v_permitidos text[];
  v_campos text[];
  v_pk text[];
  v_rel regclass;
  v_nombre text;
  v_evento text;
  quedan text[] := '{}';
  creados text[] := '{}';
  borrados text[] := '{}';
  conservados text[] := '{}';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('flujo.reconciliar'));
  IF deseados IS NULL OR jsonb_typeof(deseados) <> 'array' THEN RAISE EXCEPTION 'flujo: se esperaba una lista de suscripciones'; END IF;
  IF jsonb_array_length(deseados) = 0 AND NOT vaciar THEN
    RAISE EXCEPTION 'flujo: la lista está vacía y borraría todos los triggers; si es lo que querés, pasá vaciar = true';
  END IF;

  -- Se valida todo antes de tocar nada. Esta es la barrera real: no depende de lo que haya validado la aplicación.
  FOR x IN SELECT * FROM jsonb_array_elements(deseados) LOOP
    IF jsonb_typeof(x) <> 'object' OR coalesce(x ->> 'clave', '') !~ '^[0-9a-f]{64}$' OR coalesce(x ->> 'evento', '') !~ '^[A-Za-z0-9_.:-]{1,200}$'
       OR coalesce(x ->> 'operacion', '') NOT IN ('INSERT', 'UPDATE', 'DELETE') OR jsonb_typeof(x -> 'params') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'flujo: suscripción mal formada';
    END IF;
    SELECT p.campos INTO v_permitidos FROM flujo.permitidos p WHERE p.esquema = x ->> 'esquema' AND p.tabla = x ->> 'tabla';
    IF v_permitidos IS NULL THEN RAISE EXCEPTION 'flujo: la tabla %.% no está permitida', x ->> 'esquema', x ->> 'tabla'; END IF;
    IF jsonb_typeof(x -> 'campos') = 'array' THEN
      IF jsonb_array_length(x -> 'campos') = 0 THEN RAISE EXCEPTION 'flujo: lista de campos vacía'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(x -> 'campos') AS j WHERE jsonb_typeof(j) <> 'string' OR NOT (j #>> '{}') = ANY (v_permitidos)) THEN
        RAISE EXCEPTION 'flujo: hay campos no permitidos en %.%', x ->> 'esquema', x ->> 'tabla';
      END IF;
    ELSIF x ? 'campos' AND jsonb_typeof(x -> 'campos') <> 'null' THEN
      RAISE EXCEPTION 'flujo: «campos» tiene que ser una lista';
    END IF;
  END LOOP;

  -- Un trigger por tabla y operación, con la unión de campos: así una fila produce una sola entrada en el outbox.
  FOR g IN
    SELECT DISTINCT y ->> 'esquema' AS esquema, y ->> 'tabla' AS tabla, y ->> 'operacion' AS operacion
    FROM jsonb_array_elements(deseados) AS y ORDER BY 1, 2, 3
  LOOP
    SELECT p.campos INTO v_permitidos FROM flujo.permitidos p WHERE p.esquema = g.esquema AND p.tabla = g.tabla;
    IF g.operacion = 'UPDATE' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(deseados) AS y
      WHERE y ->> 'esquema' = g.esquema AND y ->> 'tabla' = g.tabla AND y ->> 'operacion' = 'UPDATE' AND jsonb_typeof(y -> 'campos') IS DISTINCT FROM 'array'
    ) THEN
      SELECT array_agg(DISTINCT c ORDER BY c) INTO v_campos
      FROM jsonb_array_elements(deseados) AS y,
        jsonb_array_elements_text(CASE WHEN jsonb_typeof(y -> 'campos') = 'array' THEN y -> 'campos' ELSE '[]'::jsonb END) AS c
      WHERE y ->> 'esquema' = g.esquema AND y ->> 'tabla' = g.tabla AND y ->> 'operacion' = 'UPDATE';
    ELSE
      v_campos := v_permitidos;
    END IF;

    v_rel := to_regclass(format('%I.%I', g.esquema, g.tabla));
    IF v_rel IS NULL THEN RAISE EXCEPTION 'flujo: la tabla %.% no existe', g.esquema, g.tabla; END IF;
    SELECT array_agg(a.attname::text ORDER BY k.ord) INTO v_pk
    FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE i.indrelid = v_rel AND i.indisprimary;
    IF v_pk IS NULL THEN RAISE EXCEPTION 'flujo: la tabla %.% no tiene clave primaria', g.esquema, g.tabla; END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_pk) AS c WHERE c !~ '^[a-z_][a-z0-9_]{0,62}$') THEN
      RAISE EXCEPTION 'flujo: la clave primaria de %.% tiene un nombre no admitido', g.esquema, g.tabla;
    END IF;

    v_nombre := 'flujo_' || lower(left(g.operacion, 1)) || '_' || left(md5(concat_ws('|', g.esquema, g.tabla, g.operacion, array_to_string(v_pk, ','), array_to_string(v_campos, ','))), 24);
    quedan := quedan || (g.esquema || '.' || g.tabla || '.' || v_nombre);

    IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = v_rel AND t.tgname = v_nombre AND t.tgfoid = 'flujo.registrar()'::regprocedure) THEN
      conservados := conservados || v_nombre;
    ELSE
      v_evento := CASE g.operacion
        WHEN 'UPDATE' THEN 'UPDATE OF ' || (SELECT string_agg(format('%I', c), ', ' ORDER BY c) FROM unnest(v_campos) AS c)
        ELSE g.operacion END;
      EXECUTE format('CREATE TRIGGER %I AFTER %s ON %I.%I FOR EACH ROW EXECUTE FUNCTION flujo.registrar(%L, %L)',
        v_nombre, v_evento, g.esquema, g.tabla, array_to_string(v_pk, ','), array_to_string(v_campos, ','));
      creados := creados || v_nombre;
    END IF;
  END LOOP;

  -- Solo se borran triggers que usan nuestra función: uno ajeno, aunque se llame flujo_algo, no se toca.
  FOR e IN
    SELECT t.tgname::text AS nombre, n.nspname::text AS esquema, c.relname::text AS tabla
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE t.tgfoid = 'flujo.registrar()'::regprocedure AND NOT t.tgisinternal
  LOOP
    IF NOT (e.esquema || '.' || e.tabla || '.' || e.nombre) = ANY (quedan) THEN
      EXECUTE format('DROP TRIGGER %I ON %I.%I', e.nombre, e.esquema, e.tabla);
      borrados := borrados || e.nombre;
    END IF;
  END LOOP;

  DELETE FROM flujo.suscripciones;
  INSERT INTO flujo.suscripciones (clave, evento, esquema, tabla, operacion, campos, params)
  SELECT y ->> 'clave', y ->> 'evento', y ->> 'esquema', y ->> 'tabla', y ->> 'operacion',
         CASE WHEN jsonb_typeof(y -> 'campos') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(y -> 'campos')) END,
         y -> 'params'
  FROM jsonb_array_elements(deseados) AS y;

  RETURN jsonb_build_object('creados', to_jsonb(creados), 'borrados', to_jsonb(borrados), 'conservados', to_jsonb(conservados));
END $fn$;

CREATE OR REPLACE FUNCTION flujo.tomar(cantidad integer, segundos integer) RETURNS SETOF flujo.outbox
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  UPDATE flujo.outbox o SET tomado_hasta = now() + make_interval(secs => greatest(segundos, 1)), intentos = o.intentos + 1
  WHERE o.id IN (
    SELECT p.id FROM flujo.outbox p
    WHERE p.procesado_en IS NULL AND p.fallido_en IS NULL AND (p.tomado_hasta IS NULL OR p.tomado_hasta < now())
    ORDER BY p.id LIMIT least(greatest(cantidad, 1), 1000) FOR UPDATE SKIP LOCKED
  ) RETURNING o.*;
$fn$;

CREATE OR REPLACE FUNCTION flujo.confirmar(p_id bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  UPDATE flujo.outbox SET procesado_en = now(), tomado_hasta = NULL, error = NULL WHERE id = p_id;
$fn$;

CREATE OR REPLACE FUNCTION flujo.devolver(p_id bigint, segundos integer, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  UPDATE flujo.outbox SET tomado_hasta = now() + make_interval(secs => greatest(segundos, 0)), error = left(p_error, 2000) WHERE id = p_id AND procesado_en IS NULL;
$fn$;

CREATE OR REPLACE FUNCTION flujo.fallar(p_id bigint, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  UPDATE flujo.outbox SET fallido_en = now(), tomado_hasta = NULL, error = left(p_error, 2000) WHERE id = p_id AND procesado_en IS NULL;
$fn$;

-- Solo para un administrador: lo mínimo que necesita el rol de la API.
CREATE OR REPLACE FUNCTION flujo.conceder_api(p_rol regrole) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE r text := (SELECT rolname FROM pg_roles WHERE oid = p_rol);
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE oid = p_rol) THEN RAISE EXCEPTION 'flujo: el rol de la API no puede ser superusuario'; END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA flujo TO %I', r);
  EXECUTE format('GRANT EXECUTE ON FUNCTION flujo.reconciliar(jsonb, boolean), flujo.tomar(integer, integer), flujo.confirmar(bigint), flujo.devolver(bigint, integer, text), flujo.fallar(bigint, text) TO %I', r);
  EXECUTE format('GRANT SELECT ON flujo.suscripciones TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT ON flujo.planes, flujo.pasos TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON flujo.fallidos TO %I', r);
END $fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA flujo FROM PUBLIC;
RESET ROLE;
`;
//# sourceMappingURL=sql.js.map