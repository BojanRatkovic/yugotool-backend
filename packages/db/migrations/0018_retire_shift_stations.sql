-- Spec 0012: builders work in shifts on their own; a "shift" station becomes an
-- editing agent station that keeps its shift settings. Its goal (and done
-- command, which has no field any more) moves into the prompt.
UPDATE "lines" SET "stations" = (
  SELECT jsonb_agg(
    CASE WHEN elem->>'kind' = 'shift' THEN
      (elem - 'goal' - 'doneCommand') || jsonb_build_object(
        'kind', 'agent',
        'canEdit', true,
        'prompt', concat_ws(
          E'\n\n',
          nullif(elem->>'prompt', ''),
          'Goal: ' || (elem->>'goal'),
          'Done when `' || (elem->>'doneCommand') || '` passes.'
        )
      )
    ELSE elem END
    ORDER BY ord
  )
  FROM jsonb_array_elements("stations") WITH ORDINALITY AS t(elem, ord)
)
WHERE "stations" @> '[{"kind": "shift"}]';
