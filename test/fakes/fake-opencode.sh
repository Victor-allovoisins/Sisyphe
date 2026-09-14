#!/bin/sh
# Faux binaire `opencode` pour les tests de l'OpenCodeAgentRunner : jamais la vraie CLI, jamais de quota consommé.
# Piloté par l'environnement (les variables doivent donc être dans `AgentRunOptions.env`) :
#   FAKE_OPENCODE_ARGS_FILE      : y écrit ses arguments, un par ligne (une ligne vide = argument vide)
#   FAKE_OPENCODE_PROMPT_FILE    : y écrit le prompt lu sur stdin
#   FAKE_OPENCODE_ENV_FILE       : y écrit son environnement (`env`) — sert à vérifier OPENCODE_PERMISSION
#   FAKE_OPENCODE_SCRIPT         : fichier JSONL émis sur stdout avant l'éventuelle pause
#   FAKE_OPENCODE_STDERR         : ligne émise sur stderr
#   FAKE_OPENCODE_SLEEP          : secondes de pause, dans un `sleep` enfant du même groupe de processus
#   FAKE_OPENCODE_CHILD_PID_FILE : y écrit le pid de ce `sleep` (le test vérifie qu'il a bien été tué)
#   FAKE_OPENCODE_LATE_SCRIPT    : fichier JSONL émis sur stdout après la pause
#   FAKE_OPENCODE_ORPHAN_SLEEP   : lance un `sleep` en arrière-plan qui HÉRITE de stdout, puis sort tout de
#                                  suite : la tête est morte mais le flux reste ouvert (cas du `npm run dev &`)
#   FAKE_OPENCODE_EXIT           : code de sortie (défaut 0)
set -u

if [ -n "${FAKE_OPENCODE_ARGS_FILE:-}" ]; then
  : > "$FAKE_OPENCODE_ARGS_FILE"
  for arg in "$@"; do
    printf '%s\n' "$arg" >> "$FAKE_OPENCODE_ARGS_FILE"
  done
fi

if [ -n "${FAKE_OPENCODE_ENV_FILE:-}" ]; then
  env > "$FAKE_OPENCODE_ENV_FILE"
fi

# stdin est toujours drainé : sans lecteur, le parent qui écrit le prompt prendrait un EPIPE.
if [ -n "${FAKE_OPENCODE_PROMPT_FILE:-}" ]; then
  cat > "$FAKE_OPENCODE_PROMPT_FILE"
else
  cat > /dev/null
fi

if [ -n "${FAKE_OPENCODE_SCRIPT:-}" ]; then
  cat "$FAKE_OPENCODE_SCRIPT"
fi

if [ -n "${FAKE_OPENCODE_STDERR:-}" ]; then
  printf '%s\n' "$FAKE_OPENCODE_STDERR" >&2
fi

if [ -n "${FAKE_OPENCODE_SLEEP:-}" ]; then
  sleep "$FAKE_OPENCODE_SLEEP" &
  child=$!
  if [ -n "${FAKE_OPENCODE_CHILD_PID_FILE:-}" ]; then
    printf '%s\n' "$child" > "$FAKE_OPENCODE_CHILD_PID_FILE"
  fi
  wait "$child"
fi

if [ -n "${FAKE_OPENCODE_LATE_SCRIPT:-}" ]; then
  cat "$FAKE_OPENCODE_LATE_SCRIPT"
fi

if [ -n "${FAKE_OPENCODE_ORPHAN_SLEEP:-}" ]; then
  sleep "$FAKE_OPENCODE_ORPHAN_SLEEP" &
  orphan=$!
  if [ -n "${FAKE_OPENCODE_CHILD_PID_FILE:-}" ]; then
    printf '%s\n' "$orphan" > "$FAKE_OPENCODE_CHILD_PID_FILE"
  fi
fi

exit "${FAKE_OPENCODE_EXIT:-0}"
