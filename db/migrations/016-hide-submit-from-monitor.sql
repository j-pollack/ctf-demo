-- Monitors no longer see the submit tool. Clear stored search text that still renders a submit call
-- or its result; scripts/setup.ts then re-renders it through the current visibility rules.
-- Idempotent: re-rendered rows no longer match.
UPDATE ctf.transcript_observations o
SET search_public = NULL, search_with_reasoning = NULL
WHERE o.search_public IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(o.changed_messages) WITH ORDINALITY AS m(message, position)
    WHERE (
        m.message->>'role' = 'toolResult'
        AND m.message->>'toolName' = 'submit'
        AND (o.search_public[m.position] IS NOT NULL
          OR o.search_with_reasoning[m.position] IS NOT NULL)
      )
      OR (
        m.message->>'role' = 'assistant'
        AND jsonb_path_exists(m.message, '$.content[*] ? (@.type == "toolCall" && @.name == "submit")')
        AND (o.search_public[m.position] LIKE '%[tool call submit id=%'
          OR o.search_with_reasoning[m.position] LIKE '%[tool call submit id=%')
      )
  );
