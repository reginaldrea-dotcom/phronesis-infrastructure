-- describe_table(p_table_name text) RETURNS jsonb — C1 schema-introspection tool.
--
-- Spec: artifact b3e7a1c4 (Constantinople Seq 37) / register f0928140 / baton c45d0c71. Solves the
-- per-write re-derivation tax: one call returns a complete schema picture of a public table — every
-- column (type / nullable / default / enum values / CHECK / generated flag), a cast-correct INSERT
-- skeleton over only the WRITABLE columns, and a notes[] of table-specific gotchas.
--
-- Sources: information_schema.columns (ordinal/type/nullable/default/generated) + pg_constraint
-- contype='c' (CHECK, via pg_get_constraintdef) + pg_type/pg_enum (enum value lists).
--
-- Not SECURITY DEFINER — read-only introspection. EXECUTE to service_role only (agent tool, not a
-- Navigator/anon tool). Raises clearly if the table is absent from public.

CREATE OR REPLACE FUNCTION public.describe_table(p_table_name text)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
declare
  v_exists        boolean;
  v_columns       jsonb := '[]'::jsonb;
  v_notes         jsonb := '[]'::jsonb;
  v_skel_cols     text[] := '{}';
  v_skel_vals     text[] := '{}';
  v_skel_comments text[] := '{}';
  v_gen_names     text[] := '{}';
  k               integer;
  v_has_array     boolean := false;
  v_has_uuid_arr  boolean := false;
  v_has_generated boolean := false;
  rec             record;
  v_type          text;
  v_base_type     text;
  v_enum          jsonb;
  v_check         text;
  v_is_generated  boolean;
  v_nullable      boolean;
  v_default       text;
  v_omit          boolean;
  v_placeholder   text;
  v_comment       text;
  v_skeleton      text;
begin
  -- Guard: public-schema tables only.
  select exists(
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = p_table_name
  ) into v_exists;
  if not v_exists then
    raise exception 'describe_table: table % does not exist in public schema', p_table_name;
  end if;

  for rec in
    select c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
           c.is_generated, c.ordinal_position
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = p_table_name
    order by c.ordinal_position
  loop
    v_nullable     := (rec.is_nullable = 'YES');
    v_is_generated := (rec.is_generated = 'ALWAYS');
    v_default      := rec.column_default;
    v_base_type    := regexp_replace(rec.udt_name, '^_', '');  -- strip array underscore for lookups

    -- Pretty SQL type: enum/user-defined -> type name; array -> element[]; else data_type.
    v_type := case
      when rec.data_type = 'USER-DEFINED' then rec.udt_name
      when rec.data_type = 'ARRAY'        then v_base_type || '[]'
      else rec.data_type
    end;

    -- Enum values, if the (element) type is an enum.
    select jsonb_agg(e.enumlabel order by e.enumsortorder)
      into v_enum
    from pg_type t join pg_enum e on e.enumtypid = t.oid
    where t.typname = v_base_type and t.typtype = 'e';

    -- CHECK constraint(s) that reference this column (stripped of the CHECK keyword).
    select string_agg(regexp_replace(pg_get_constraintdef(con.oid), '^CHECK ', ''), ' AND ')
      into v_check
    from pg_constraint con
    join pg_class cl     on cl.oid = con.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
    join pg_attribute att on att.attrelid = cl.oid and att.attnum = any(con.conkey)
    where ns.nspname = 'public' and cl.relname = p_table_name
      and con.contype = 'c' and att.attname = rec.column_name;

    v_columns := v_columns || jsonb_build_object(
      'name',             rec.column_name,
      'type',             v_type,
      'nullable',         v_nullable,
      'default',          v_default,
      'enum_values',      v_enum,            -- null when not an enum
      'check_constraint', v_check,           -- null when no CHECK references it
      'generated',        v_is_generated     -- spec: generated columns included but flagged
    );

    if v_is_generated then
      v_has_generated := true;
      v_gen_names := v_gen_names || rec.column_name;
    end if;
    if rec.data_type = 'ARRAY' then
      v_has_array := true;
      if v_base_type = 'uuid' then v_has_uuid_arr := true; end if;
    end if;

    -- INSERT skeleton: omit generated columns and auto-generating defaults (uuid/now/nextval);
    -- keep everything else writable (incl. constant/'{}' defaults, commented so callers can override).
    v_omit := v_is_generated
      or (v_default is not null and (
              v_default ilike '%gen_random_uuid%'
           or v_default ilike '%uuid_generate%'
           or v_default ilike '%now()%'
           or v_default ilike 'nextval(%'
      ));

    if not v_omit then
      v_placeholder := case
        when rec.data_type = 'ARRAY' then 'ARRAY[''[' || v_base_type || ']'']::' || v_base_type || '[]'
        when v_enum is not null      then '''[enum]'''
        when v_base_type = 'uuid'    then '''[uuid]'''
        when v_base_type in ('jsonb','json') then
          case when coalesce(v_default,'') ilike '%{}%' then '''{}''::' || v_base_type
               else '''[json]''::' || v_base_type end
        when v_base_type in ('int2','int4','int8','integer','bigint','smallint','numeric','float4','float8') then '[number]'
        when v_base_type in ('bool','boolean') then '[true|false]'
        when rec.data_type ilike 'timestamp%' then '''[timestamp]'''
        when rec.data_type = 'date' then '''[date]'''
        else '''[text]'''
      end;

      v_comment := rec.column_name || ': ' || v_type
        || case when not v_nullable then ' NOT NULL' else '' end
        || case when v_enum is not null
                then ' — values: ' || array_to_string(array(select jsonb_array_elements_text(v_enum)), ',')
                else '' end
        || case when v_check is not null then ' — CHECK: ' || v_check else '' end
        || case when v_default is not null then ' — default: ' || v_default else '' end;

      v_skel_cols     := v_skel_cols || rec.column_name;
      v_skel_vals     := v_skel_vals || v_placeholder;
      v_skel_comments := v_skel_comments || v_comment;
    end if;
  end loop;

  -- Assemble the skeleton: the value-separator comma must sit BEFORE the trailing comment, or the
  -- line comment swallows it and the pasted INSERT fails to parse.
  v_skeleton := 'INSERT INTO ' || p_table_name || ' (' || array_to_string(v_skel_cols, ', ') || ')'
              || chr(10) || 'VALUES (' || chr(10);
  for k in 1 .. coalesce(array_length(v_skel_cols, 1), 0) loop
    v_skeleton := v_skeleton || '  ' || v_skel_vals[k]
                || case when k < array_length(v_skel_cols, 1) then ',' else '' end
                || '  -- ' || v_skel_comments[k] || chr(10);
  end loop;
  v_skeleton := v_skeleton || ');';

  if v_has_generated then
    v_notes := v_notes || to_jsonb(
      'Generated columns (' || array_to_string(v_gen_names, ', ') || ') are read-only — omit from INSERT.'::text);
  end if;
  if v_has_array then
    v_notes := v_notes || to_jsonb('Array columns need ARRAY[...] or ''{...}''::type[] syntax.'::text);
  end if;
  if v_has_uuid_arr then
    v_notes := v_notes || to_jsonb('uuid[] arrays: ARRAY[''...'']::uuid[]'::text);
  end if;

  return jsonb_build_object(
    'table',           p_table_name,
    'columns',         v_columns,
    'insert_skeleton', v_skeleton,
    'notes',           v_notes
  );
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.describe_table(text) FROM public;
GRANT EXECUTE ON FUNCTION public.describe_table(text) TO service_role;
