#!/bin/sh
# Installation et mise à jour de Sisyphe sur macOS ou Ubuntu.
# POSIX sh volontairement : aucune dépendance à bash.
# Contrat : docs/superpowers/specs/2026-09-10-sisyphe-install-service-design.md §2.
#
#   ./install.sh [--dry-run] [--no-setup] [--no-pull]
#
# Relancer le script = mettre à jour : git pull --ff-only puis rebuild.

set -eu

DRY_RUN=0
NO_SETUP=0
NO_PULL=0
STEP="démarrage"

# Ligne ajoutée au profil quand un binaire est posé dans ~/.local/bin.
LOCAL_BIN_LINE='export PATH="$HOME/.local/bin:$PATH"'

# printf (intégré au shell) plutôt que cat : les messages doivent sortir même
# avec un PATH cassé, c est justement ce qu un bootstrap rencontre.
usage() {
	printf '%s\n' \
		'Usage : ./install.sh [options]' \
		'' \
		'  --dry-run    affiche les commandes sans rien exécuter' \
		'  --no-setup   n exécute pas « sisyphe setup » à la fin' \
		'  --no-pull    ne tente pas « git pull --ff-only » sur le clone' \
		'  -h, --help   cette aide'
}

# Sur une sortie en erreur, nommer l étape fautive (set -e coupe sans contexte).
on_exit() {
	code=$?
	if [ "$code" -ne 0 ]; then
		printf '\nÉchec pendant : %s (code %s)\n' "$STEP" "$code" >&2
	fi
}
trap on_exit EXIT

step() {
	STEP="$1"
	printf '\n== %s\n' "$1"
}

# Affiche la commande puis l exécute (rien d exécuté en --dry-run).
run() {
	printf '+ %s\n' "$*"
	if [ "$DRY_RUN" = 1 ]; then
		return 0
	fi
	"$@"
}

# Variante pour les commandes qui ont besoin d un shell (redirection, cd).
# « set -e » dans le sous-shell : une commande qui échoue arrête la suite.
run_shell() {
	printf '+ %s\n' "$1"
	if [ "$DRY_RUN" = 1 ]; then
		return 0
	fi
	sh -c "set -e; $1"
}

have() {
	command -v "$1" >/dev/null 2>&1
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--no-setup) NO_SETUP=1 ;;
		--no-pull) NO_PULL=1 ;;
		-h|--help) usage; exit 0 ;;
		*)
			printf 'Option inconnue : %s\n\n' "$1" >&2
			usage >&2
			exit 2
			;;
	esac
	shift
done

# Le script travaille toujours dans son propre répertoire, d où qu il soit appelé.
# « dirname » n est pas garanti sur un PATH réduit : expansion de paramètre.
case "$0" in
	*/*) script_dir=${0%/*} ;;
	*) script_dir=. ;;
esac
SCRIPT_DIR=$(CDPATH= cd -- "$script_dir" && pwd)
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------- détection OS

step "Détection du système"
detect_os() {
	if [ -n "${SISYPHE_INSTALL_OS:-}" ]; then
		printf '%s' "$SISYPHE_INSTALL_OS"
		return 0
	fi
	if [ "$(uname -s)" = Darwin ]; then
		printf 'darwin'
		return 0
	fi
	if grep -Eqs '^(ID|ID_LIKE)=.*(ubuntu|debian)' /etc/os-release; then
		printf 'ubuntu'
		return 0
	fi
	printf 'inconnu'
}
OS=$(detect_os)
case "$OS" in
	darwin) printf '  macOS\n' ;;
	ubuntu) printf '  Ubuntu (ou dérivé Debian)\n' ;;
	*)
		printf 'Système non géré : %s\n' "$OS" >&2
		printf 'Sisyphe ne sait installer que macOS et Ubuntu (ou un dérivé Debian).\n' >&2
		printf 'Forcer la détection : SISYPHE_INSTALL_OS=darwin|ubuntu ./install.sh\n' >&2
		exit 1
		;;
esac

# ------------------------------------------------------------------ utilitaires

require_brew() {
	if have brew; then
		return 0
	fi
	printf '%s\n' \
		'Homebrew est requis sur macOS et reste introuvable. L installer une fois :' \
		'  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' \
		'puis relancer ce script.' >&2
	exit 1
}

# Ajoute ~/.local/bin au profil (une seule fois) et au PATH de ce script.
ensure_local_bin_on_path() {
	profile="$HOME/.profile"
	if [ -f "$profile" ] && grep -qF "$LOCAL_BIN_LINE" "$profile"; then
		printf '  %s contient déjà la ligne PATH\n' "$profile"
	else
		run_shell "printf '%s\\n' '$LOCAL_BIN_LINE' >> \"$profile\""
	fi
	case ":$PATH:" in
		*":$HOME/.local/bin:"*) ;;
		*) PATH="$HOME/.local/bin:$PATH"; export PATH ;;
	esac
}

# Bascule npm sur un préfixe utilisateur si le préfixe global n est pas
# accessible en écriture (Ubuntu + NodeSource : /usr/lib/node_modules).
# Jamais de npm sous sudo.
ensure_npm_prefix() {
	# npm absent : node vient d être installé plus haut (ou le sera par le
	# gestionnaire de paquets) et son préfixe est celui de l utilisateur ;
	# rien à décider ici.
	if ! have npm; then
		return 0
	fi
	prefix=$(npm prefix -g 2>/dev/null) || return 0
	if [ -z "$prefix" ] || [ -w "$prefix" ]; then
		return 0
	fi
	printf '  préfixe npm global non inscriptible (%s)\n' "$prefix"
	run npm config set prefix "$HOME/.local"
	ensure_local_bin_on_path
}

# Version majeure de node, ou rien si node est absent ou illisible.
node_major() {
	v=$(node -v 2>/dev/null) || return 1
	v=${v#v}
	v=${v%%.*}
	case "$v" in
		''|*[!0-9]*) return 1 ;;
	esac
	printf '%s' "$v"
}

# --------------------------------------------------------------------- 1. git

step "git"
if have git; then
	printf '  déjà présent\n'
else
	case "$OS" in
		darwin)
			require_brew
			run brew install git
			;;
		ubuntu)
			# Seul apt sait poser git : c est la seule commande sudo hors
			# installation de Node (impossible dans le compte utilisateur).
			run sudo apt-get install -y git
			;;
	esac
fi

# -------------------------------------------------------------------- 2. Node

step "Node 24 ou plus"
major=""
if have node; then
	major=$(node_major) || major=""
fi
if [ -n "$major" ] && [ "$major" -ge 24 ]; then
	printf '  node v%s : ok\n' "$major"
else
	case "$OS" in
		darwin)
			require_brew
			if [ -n "$major" ]; then
				printf '  node v%s trop ancien\n' "$major"
				run brew upgrade node
			else
				run brew install node
			fi
			;;
		ubuntu)
			# Dépôt NodeSource. Le script d installation est téléchargé puis
			# exécuté (et non « curl | sudo bash ») : un téléchargement
			# tronqué ne peut pas être exécuté à moitié sous sudo.
			nodesource="${TMPDIR:-/tmp}/sisyphe-nodesource-$$.sh"
			run curl -fsSL -o "$nodesource" https://deb.nodesource.com/setup_24.x
			run sudo -E bash "$nodesource"
			run rm -f "$nodesource"
			run sudo apt-get install -y nodejs
			;;
	esac
fi

# ---------------------------------------------------------------- 3. gitleaks

install_gitleaks_ubuntu() {
	case "$(uname -m)" in
		x86_64|amd64) arch=linux_x64 ;;
		aarch64|arm64) arch=linux_arm64 ;;
		*)
			printf 'Architecture non gérée pour gitleaks : %s\n' "$(uname -m)" >&2
			exit 1
			;;
	esac
	api="https://api.github.com/repos/gitleaks/gitleaks/releases/latest"
	printf '+ %s\n' "curl -fsSL $api"
	if [ "$DRY_RUN" = 1 ]; then
		tag="v<version>"
	else
		tag=$(curl -fsSL "$api" \
			| sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
			| head -n 1)
		if [ -z "$tag" ]; then
			printf 'Impossible de lire la dernière release de gitleaks.\n' >&2
			exit 1
		fi
	fi
	# Le nom de l archive ne porte pas le « v » du tag.
	version=${tag#v}
	asset="gitleaks_${version}_${arch}.tar.gz"
	base="https://github.com/gitleaks/gitleaks/releases/download/${tag}"
	tmp="${TMPDIR:-/tmp}/sisyphe-gitleaks-$$"
	run mkdir -p "$tmp"
	run curl -fsSL -o "$tmp/$asset" "$base/$asset"
	run curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
	# --ignore-missing saute les autres archives de la release, pas la nôtre :
	# si aucune ligne ne correspond au fichier téléchargé, coreutils sort en
	# erreur (« no file was verified ») au lieu de valider dans le vide.
	run_shell "cd \"$tmp\" && sha256sum --ignore-missing -c checksums.txt"
	run tar -xzf "$tmp/$asset" -C "$tmp" gitleaks
	run mkdir -p "$HOME/.local/bin"
	run install -m 0755 "$tmp/gitleaks" "$HOME/.local/bin/gitleaks"
	run rm -rf "$tmp"
	ensure_local_bin_on_path
}

step "gitleaks"
if have gitleaks; then
	printf '  déjà présent\n'
else
	case "$OS" in
		darwin)
			require_brew
			run brew install gitleaks
			;;
		ubuntu)
			install_gitleaks_ubuntu
			;;
	esac
fi

# ------------------------------------------------------------ 4. CLI Claude Code

step "CLI Claude Code"
# Avant toute installation globale npm : le préfixe doit être inscriptible.
ensure_npm_prefix
if have claude; then
	printf '  déjà présent\n'
else
	run npm install -g @anthropic-ai/claude-code
fi

# ---------------------------------------------------- 5. mise à jour et build

step "Sisyphe (build et lien global)"
printf '  répertoire : %s\n' "$SCRIPT_DIR"
if [ "$NO_PULL" = 1 ]; then
	printf '  mise à jour ignorée (--no-pull)\n'
elif ! have git; then
	printf '  mise à jour ignorée : git indisponible\n'
elif ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	printf '  mise à jour ignorée : pas un clone git\n'
elif [ -z "$(git remote 2>/dev/null || true)" ]; then
	printf '  mise à jour ignorée : aucun dépôt distant\n'
elif [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
	printf '  mise à jour ignorée : arbre de travail modifié\n'
else
	run git pull --ff-only
fi
run npm ci
run npm run build
run npm link

# -------------------------------------------------------------- 6. sisyphe setup

step "Configuration"
config="${SISYPHE_HOME:-$HOME/.sisyphe}/config.yml"
if [ "$NO_SETUP" = 1 ]; then
	printf '  ignorée (--no-setup)\n'
elif [ -f "$config" ]; then
	printf '  configuration déjà présente : %s\n' "$config"
	printf '  (réécrire le service : sisyphe setup --reinstall-service)\n'
elif [ "$DRY_RUN" != 1 ] && ! have sisyphe; then
	printf '  sisyphe introuvable sur le PATH : ouvrir un nouveau terminal puis lancer « sisyphe setup »\n'
else
	run sisyphe setup
fi

# ------------------------------------------------------------------ 7. épilogue

step "Prochaines étapes"
if have claude && claude auth status --json 2>/dev/null | grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
	printf '  claude : session active\n'
else
	printf '  lancer : claude login\n'
fi
printf '  lancer : sisyphe ui\n'
