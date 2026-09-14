#!/bin/sh
# Faux binaire `codex` pour les tests du CodexAgentRunner : jamais la vraie CLI, jamais de quota consommé.
# Piloté par l'environnement (les variables doivent donc être dans `AgentRunOptions.env`) :
#   FAKE_CODEX_ARGS_FILE       : y écrit ses arguments, un par ligne (une ligne vide = argument vide)
#   FAKE_CODEX_PROMPT_FILE     : y écrit le prompt lu sur stdin
#   FAKE_CODEX_ENV_FILE        : y écrit son environnement (`env`)
#   FAKE_CODEX_SCRIPT          : fichier JSONL émis sur stdout avant l'éventuelle pause
#   FAKE_CODEX_RESULT          : contenu écrit dans le fichier `-o`/`--output-last-message`
#   FAKE_CODEX_STDERR          : ligne émise sur stderr
#   FAKE_CODEX_SLEEP           : secondes de pause, dans un `sleep` enfant du même groupe de processus
#   FAKE_CODEX_CHILD_PID_FILE  : y écrit le pid de ce `sleep` (le test vérifie qu'il a bien été tué)
#   FAKE_CODEX_LATE_SCRIPT     : fichier JSONL émis sur stdout après la pause
#   FAKE_CODEX_ORPHAN_SLEEP    : lance un `sleep` en arrière-plan qui HÉRITE de stdout, puis sort tout de
#                                suite : la tête est morte mais le flux reste ouvert (cas du `npm run dev &`)
#   FAKE_CODEX_EXIT            : code de sortie (défaut 0)
set -u

# Le fichier de sortie est passé après `-o` ou `--output-last-message`.
out_file=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ] || [ "$prev" = "--output-last-message" ]; then
    out_file="$arg"
  fi
  prev="$arg"
done

if [ -n "${FAKE_CODEX_ARGS_FILE:-}" ]; then
  : > "$FAKE_CODEX_ARGS_FILE"
  for arg in "$@"; do
    printf '%s\n' "$arg" >> "$FAKE_CODEX_ARGS_FILE"
  done
fi

if [ -n "${FAKE_CODEX_ENV_FILE:-}" ]; then
  env > "$FAKE_CODEX_ENV_FILE"
fi

# stdin est toujours drainé : sans lecteur, le parent qui écrit le prompt prendrait un EPIPE.
if [ -n "${FAKE_CODEX_PROMPT_FILE:-}" ]; then
  cat > "$FAKE_CODEX_PROMPT_FILE"
else
  cat > /dev/null
fi

if [ -n "${FAKE_CODEX_SCRIPT:-}" ]; then
  cat "$FAKE_CODEX_SCRIPT"
fi

if [ -n "${FAKE_CODEX_STDERR:-}" ]; then
  printf '%s\n' "$FAKE_CODEX_STDERR" >&2
fi

if [ -n "${FAKE_CODEX_SLEEP:-}" ]; then
  sleep "$FAKE_CODEX_SLEEP" &
  child=$!
  if [ -n "${FAKE_CODEX_CHILD_PID_FILE:-}" ]; then
    printf '%s\n' "$child" > "$FAKE_CODEX_CHILD_PID_FILE"
  fi
  wait "$child"
fi

if [ -n "${FAKE_CODEX_LATE_SCRIPT:-}" ]; then
  cat "$FAKE_CODEX_LATE_SCRIPT"
fi

if [ -n "${FAKE_CODEX_RESULT:-}" ] && [ -n "$out_file" ]; then
  printf '%s' "$FAKE_CODEX_RESULT" > "$out_file"
fi

if [ -n "${FAKE_CODEX_ORPHAN_SLEEP:-}" ]; then
  sleep "$FAKE_CODEX_ORPHAN_SLEEP" &
  orphan=$!
  if [ -n "${FAKE_CODEX_CHILD_PID_FILE:-}" ]; then
    printf '%s\n' "$orphan" > "$FAKE_CODEX_CHILD_PID_FILE"
  fi
fi

exit "${FAKE_CODEX_EXIT:-0}"
