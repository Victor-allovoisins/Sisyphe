#!/bin/sh
# Installation et mise à jour de Sisyphe sur macOS ou Ubuntu.
# POSIX sh volontairement : aucune dépendance à bash.
# Contrat : docs/superpowers/specs/2026-09-10-sisyphe-install-service-design.md §2.
#
#   ./install.sh [--dry-run] [--no-setup] [--no-pull]
#
# Relancer le script = mettre à jour : git pull --ff-only, rebuild, puis
# redémarrage du service s il tournait — le daemon exécute dist/, qu un rebuild
# ne change pas pour un processus déjà lancé.
# Le script est lu une fois au lancement : une version récupérée par le
# git pull de l étape 5 ne prend effet qu au lancement suivant (pas de ré-exec).

set -eu

DRY_RUN=0
NO_SETUP=0
NO_PULL=0
STEP="démarrage"

# Version épinglée : une release surprise ne doit pas changer ce qui est posé
# sur la machine. La somme de contrôle vient du même canal non signé : elle
# garantit l intégrité du téléchargement, pas son authenticité.
GITLEAKS_VERSION=8.30.1

# Ligne ajoutée au profil quand un binaire est posé dans ~/.local/bin.
LOCAL_BIN_LINE='export PATH="$HOME/.local/bin:$PATH"'

# Chemins temporaires réels, effacés par le trap EXIT (succès comme échec).
NODESOURCE_TMP=""
GITLEAKS_TMP=""

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

# Nettoyage des temporaires, puis nom de l étape fautive (set -e coupe sans
# contexte). Le code de sortie du script est préservé.
on_exit() {
	code=$?
	if [ -n "$NODESOURCE_TMP" ]; then
		rm -f "$NODESOURCE_TMP"
	fi
	if [ -n "$GITLEAKS_TMP" ]; then
		rm -rf "$GITLEAKS_TMP"
	fi
	if [ "$code" -ne 0 ]; then
		printf '\nÉchec pendant : %s (code %s)\n' "$STEP" "$code" >&2
	fi
}
trap on_exit EXIT

step() {
	STEP="$1"
	printf '\n== %s\n' "$1"
}

# Rend un argument copiable-collable : apostrophes autour de tout ce qui sort
# d un jeu de caractères sûrs (une espace dans un chemin, notamment).
quote_arg() {
	case "$1" in
		'') printf "''"; return 0 ;;
		*[!A-Za-z0-9_@%+=:,./-]*) ;;
		*) printf '%s' "$1"; return 0 ;;
	esac
	rest=$1
	printf "'"
	while :; do
		case "$rest" in
			*\'*)
				printf '%s' "${rest%%\'*}"
				printf '%s' "'\\''"
				rest=${rest#*\'}
				;;
			*)
				printf '%s' "$rest"
				break
				;;
		esac
	done
	printf "'"
}

display_cmd() {
	out=""
	for a in "$@"; do
		out="$out $(quote_arg "$a")"
	done
	printf '%s' "${out# }"
}

# Affiche la commande puis l exécute (rien d exécuté en --dry-run).
run() {
	printf '+ %s\n' "$(display_cmd "$@")"
	if [ "$DRY_RUN" = 1 ]; then
		return 0
	fi
	"$@"
}

# Variante pour les commandes qui ont besoin d un shell (redirection, cd).
# Les valeurs sont passées en arguments positionnels ($1, $2…) : rien n est
# interpolé dans le texte du script. « set -e » dans le sous-shell : une
# commande qui échoue arrête la suite.
run_sh() {
	display=$1
	script=$2
	shift 2
	printf '+ %s\n' "$display"
	if [ "$DRY_RUN" = 1 ]; then
		return 0
	fi
	sh -c "set -e; $script" _ "$@"
}

have() {
	command -v "$1" >/dev/null 2>&1
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--no-setup) NO_SETUP=1 ;;
		--no-pull) NO_PULL=1 ;;
		-h|--help) trap - EXIT; usage; exit 0 ;;
		*)
			printf 'Option inconnue : %s\n\n' "$1" >&2
			usage >&2
			trap - EXIT
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

# Ajoute la ligne PATH à un fichier de profil, une seule fois.
append_profile_line() {
	target=$1
	if [ -f "$target" ] && grep -qF "$LOCAL_BIN_LINE" "$target"; then
		printf '  %s contient déjà la ligne PATH\n' "$target"
		return 0
	fi
	run_sh "printf '%s\\n' $(quote_arg "$LOCAL_BIN_LINE") >> $(quote_arg "$target")" \
		'printf "%s\n" "$1" >> "$2"' "$LOCAL_BIN_LINE" "$target"
}

# Ajoute ~/.local/bin au profil et au PATH de ce script.
ensure_local_bin_on_path() {
	append_profile_line "$HOME/.profile"
	# zsh, shell par défaut de macOS, ne lit jamais ~/.profile : sans cette
	# seconde ligne, le « sisyphe ui » de l épilogue serait introuvable.
	if [ -f "$HOME/.zshrc" ] || [ -f "$HOME/.zprofile" ]; then
		append_profile_line "$HOME/.zprofile"
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
	if [ -z "$prefix" ]; then
		return 0
	fi
	if [ "$prefix" = "$HOME/.local" ]; then
		# Bascule déjà faite par une exécution précédente : la ligne de profil
		# est revérifiée quand même, elle a pu être perdue depuis.
		ensure_local_bin_on_path
		return 0
	fi
	if [ -w "$prefix" ]; then
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

# Après une installation réelle, l outil doit répondre : sinon on s arrête ici
# plutôt que de continuer avec un environnement à moitié installé.
verify_installed() {
	if [ "$DRY_RUN" = 1 ]; then
		return 0
	fi
	if have "$1"; then
		printf '  %s : ok\n' "$1"
		return 0
	fi
	printf '%s\n' \
		"$1 reste introuvable après son installation." \
		"  vérifier : command -v $1" >&2
	exit 1
}

verify_node() {
	if [ "$DRY_RUN" = 1 ]; then
		return 0
	fi
	installed=$(node_major) || installed=""
	if [ -n "$installed" ] && [ "$installed" -ge 24 ]; then
		printf '  node v%s : ok\n' "$installed"
		return 0
	fi
	printf '%s\n' \
		"Node 24 ou plus reste introuvable après installation (vu : ${installed:-aucun})." \
		"  vérifier : command -v node" \
		"  cause la plus fréquente : un gestionnaire de versions (nvm, fnm, volta) place" \
		"  son shim avant le node installé ici. Changer sa version par défaut, ou retirer" \
		"  son shim du PATH, puis relancer ce script." >&2
	exit 1
}

# --------------------------------------------------- 1. git et prérequis système

step "git et prérequis système"
case "$OS" in
	darwin)
		if have git; then
			printf '  git déjà présent\n'
		else
			require_brew
			run brew install git
			verify_installed git
		fi
		;;
	ubuntu)
		# curl sert aux étapes Node et gitleaks, ca-certificates au TLS : les
		# poser ici rend l étape autosuffisante sur une image minimale.
		# apt-get est la seule commande sudo hors installation de Node : rien
		# de tout cela ne s installe dans le compte utilisateur.
		if have git && have curl; then
			printf '  git et curl déjà présents\n'
		else
			run sudo apt-get update
			run sudo apt-get install -y git curl ca-certificates
			verify_installed git
			verify_installed curl
		fi
		;;
esac

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
			# « upgrade » seulement si c est bien brew qui a posé node : sinon
			# (node venu de nvm, fnm, volta…) brew upgrade échouerait.
			run_sh 'brew list node >/dev/null 2>&1 && brew upgrade node || brew install node' \
				'brew list node >/dev/null 2>&1 && brew upgrade node || brew install node'
			;;
		ubuntu)
			# Dépôt NodeSource. Le script d installation est téléchargé puis
			# exécuté (et non « curl | sudo bash ») : un téléchargement
			# tronqué ne peut pas être exécuté à moitié sous sudo. Pas de -E :
			# l environnement non privilégié n a rien à faire dans un shell root.
			if [ "$DRY_RUN" = 1 ]; then
				nodesource="/tmp/sisyphe-nodesource.XXXXXX.sh"
			else
				NODESOURCE_TMP=$(mktemp "${TMPDIR:-/tmp}/sisyphe-nodesource.XXXXXX")
				nodesource=$NODESOURCE_TMP
			fi
			run curl -fsSL -o "$nodesource" https://deb.nodesource.com/setup_24.x
			run sudo bash "$nodesource"
			run sudo apt-get install -y nodejs
			;;
	esac
	verify_node
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
	# Le nom de l archive ne porte pas le « v » du tag.
	asset="gitleaks_${GITLEAKS_VERSION}_${arch}.tar.gz"
	base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
	if [ "$DRY_RUN" = 1 ]; then
		tmp="/tmp/sisyphe-gitleaks.XXXXXX"
	else
		GITLEAKS_TMP=$(mktemp -d "${TMPDIR:-/tmp}/sisyphe-gitleaks.XXXXXX")
		tmp=$GITLEAKS_TMP
	fi
	run curl -fsSL -o "$tmp/$asset" "$base/$asset"
	run curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
	# --ignore-missing saute les autres archives de la release, pas la nôtre :
	# si aucune ligne ne correspond au fichier téléchargé, coreutils sort en
	# erreur (« no file was verified ») au lieu de valider dans le vide.
	run_sh "cd $(quote_arg "$tmp") && sha256sum --ignore-missing -c checksums.txt" \
		'cd "$1" && sha256sum --ignore-missing -c checksums.txt' "$tmp"
	run tar -xzf "$tmp/$asset" -C "$tmp" gitleaks
	run mkdir -p "$HOME/.local/bin"
	run install -m 0755 "$tmp/gitleaks" "$HOME/.local/bin/gitleaks"
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
	verify_installed gitleaks
fi

# ------------------------------------------------------------ 4. CLI Claude Code

step "CLI Claude Code"
# Avant toute installation globale npm : le préfixe doit être inscriptible.
ensure_npm_prefix
if have claude; then
	printf '  déjà présent\n'
else
	run npm install -g @anthropic-ai/claude-code
	verify_installed claude
fi

# ---------------------------------------------------- 5. mise à jour et build

step "Sisyphe (build et lien global)"
printf '  répertoire : %s\n' "$SCRIPT_DIR"
# État du service relevé maintenant, avant que le build ne remplace dist/ : après, la commande
# « sisyphe » pointerait sur des fichiers en cours de réécriture. C est lui qui décide, plus bas,
# s il faut redémarrer — une mise à jour ne doit pas démarrer un daemon qu on avait laissé arrêté.
WAS_RUNNING=0
if [ "$DRY_RUN" != 1 ] && have sisyphe && sisyphe service status 2>/dev/null | grep -q 'running : true'; then
	WAS_RUNNING=1
fi
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
elif ! run git pull --ff-only; then
	# Branche sans suivi distant, historique divergent, HEAD détachée : on
	# construit l état local plutôt que d abandonner l installation.
	printf '  mise à jour impossible (pas de suivi distant ou historique divergent) — build sur l état local\n'
fi
run npm ci
run npm run build
run npm link

# -------------------------------------------------------------- 6. sisyphe setup

step "Configuration"
config="${SISYPHE_HOME:-$HOME/.sisyphe}/config.yml"
if [ "$NO_SETUP" = 1 ]; then
	printf '  ignorée (--no-setup)\n'
elif [ "$DRY_RUN" != 1 ] && ! have sisyphe; then
	printf '  sisyphe introuvable sur le PATH : ouvrir un nouveau terminal puis lancer « sisyphe setup »\n'
elif [ -f "$config" ]; then
	# Mise à jour : rien à redemander, mais le service posé par une version
	# antérieure doit être réécrit — sinon l ancien agent (RunAtLoad true,
	# KeepAlive inconditionnel) survit à la mise à jour et contredit tout ce
	# qu affichent « sisyphe service status » et l interface. La commande est
	# idempotente et ne démarre rien.
	printf '  configuration déjà présente : %s\n' "$config"
	if ! run sisyphe setup --reinstall-service; then
		# Le build est déjà en place : ne pas faire échouer l installation pour ça.
		printf '  réinstallation du service impossible : relancer « sisyphe setup --reinstall-service »\n'
	fi
else
	run sisyphe setup
fi

# --------------------------------------------------------- 7. redémarrage du service

step "Service"
if [ "$DRY_RUN" = 1 ]; then
	printf '  redémarré seulement s il tournait avant la mise à jour\n'
elif [ "$WAS_RUNNING" = 1 ]; then
	printf '  le daemon tournait : redémarrage sur la nouvelle version\n'
	# Un job en cours est repris au démarrage suivant par la réconciliation : on ne l attend pas.
	if ! run sisyphe service stop || ! run sisyphe service start; then
		printf '  redémarrage impossible : relancer « sisyphe service start »\n'
	fi
else
	printf '  daemon arrêté : rien à redémarrer\n'
fi

# ------------------------------------------------------------------ 8. épilogue

step "Prochaines étapes"
if [ "$DRY_RUN" = 1 ]; then
	printf '  lancer : claude login (si la session Claude Code n est pas ouverte)\n'
elif have claude && claude auth status --json 2>/dev/null | grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
	printf '  claude : session active\n'
else
	printf '  lancer : claude login\n'
fi
printf '  recharger le PATH du shell courant : exec $SHELL -l\n'
printf '  lancer : sisyphe ui\n'
