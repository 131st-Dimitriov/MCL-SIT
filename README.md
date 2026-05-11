# MCL-SIT

Système d'Information Tactique (SIT) pour DCS World, packagé en application Electron.

## Architecture (V16)

```
mcl-sit/
├── src/
│   ├── main/         Process Electron (main + sous-process serveur)
│   ├── renderer/     Interface SIT (HTML/CSS/JS, ex-leclerc-sit.html)
│   ├── server/       Hub Node (ex-sit-multi.js)
│   └── lua/          Hook DCS (copié post-install dans Saved Games)
├── build/            Ressources installeur (icône, scripts NSIS)
└── dist/             Builds générés (gitignoré)
```

## Pré-requis développeur

- Node.js 18+ (recommandé 20 LTS)
- npm

## Installation

```bash
cd mcl-sit
npm install
```

Cette commande télécharge ~250 MB de dépendances (Electron + builder). Une seule fois.

## Lancer en mode dev

```bash
npm start          # production-like
npm run start:dev  # avec DevTools ouverts
```

Le SIT s'affiche dans une fenêtre Electron. Au Lot 1, c'est exactement comme ouvrir
l'ancien `leclerc-sit-v15.html` dans Chrome, mais dans une fenêtre dédiée.

## Builder un .exe portable (pour tester sans installeur)

```bash
npm run build:portable
```

Génère un `.exe` autonome dans `dist/`. Aucune installation requise, double-clic = lancement.

## Builder un installeur NSIS

```bash
npm run build
```

Génère `dist/MCL-SIT-Setup-16.0.0.exe`. Lot 3 ajoutera la sélection du dossier DCS
et la copie du hook.

## Publier une nouvelle version (Lot 5+)

```bash
npm version patch    # bump 16.0.0 → 16.0.1
npm run release      # build + upload sur GitHub Releases
```

Nécessite la variable d'environnement `GH_TOKEN` (token GitHub avec scope `repo`).

## Progression

- [x] **Lot 1** — Squelette Electron : fenêtre + SIT V15 actuel embarqué
- [ ] **Lot 2** — Splash + modes Client / Server / Both
- [ ] **Lot 3** — Installeur NSIS avec sélection dossier DCS + hook + pare-feu
- [ ] **Lot 4** — Obfuscation JS + ASAR intégrité
- [ ] **Lot 5** — Auto-update via GitHub Releases
- [ ] **Lot 6** — Configuration GitHub + premier push
