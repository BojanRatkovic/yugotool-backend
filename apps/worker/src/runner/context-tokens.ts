// Pure: how full a session's context window is, from an assistant message's usage.

interface Usage {
  input_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Tokens the model saw for one turn: fresh input plus cached reads and writes. */
export function contextTokensOf(usage: Usage): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}
