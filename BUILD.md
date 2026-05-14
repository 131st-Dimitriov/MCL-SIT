# BUILD — Comment produire l'installeur MCL-SIT-Setup-X.Y.Z.exe

## Pré-requis à installer une seule fois sur ton PC dev

### 1. Node.js
Installer Node.js LTS depuis https://nodejs.org/fr/download
Choisir « Windows Installer (.msi) » 64-bit. Tout par défaut.

Vérifier dans PowerShell :
```
node --version
npm --version
```

### 2. Inno Setup
Installer Inno Setup 6 depuis https://jrsoftware.org/isdl.php
Tout par défaut.

### 3. Dépendances du projet
Dans le dossier du projet (par exemple `D:\dev\mcl-sit\`), ouvrir un terminal et lancer :
```
npm install
```

Une seule fois. Ça télécharge ~250 MB de dépendances Electron dans `node_modules\`.

## Workflow à chaque release

### Étape 1 : bumper la version (optionnel mais recommandé)

Édite `package.json`, change la ligne `"version": "18.0.0"` selon ce que tu veux.

**Important** : pense à mettre la même version dans `installer/mcl-sit-installer.iss` à la ligne `#define AppVersion "18.0.0"`. Sinon le setup et l'app afficheront des versions différentes.

### Étape 2 : générer l'Electron portable

Dans le dossier du projet :
```
npm run build:installer
```

Ce que ça fait :
- Compile l'app Electron complète dans `dist\win-unpacked\`
- **Obfusque tout le code source JS** (`src/main/*.js`, `src/server/*.js`) — voir scripts/obfuscate.js
- **Active les fuses Electron** : intégrité ASAR, blocage des modes debug, etc.
- Vérifie que tout est OK
- Affiche le chemin de l'exe principal

Durée : 1 à 3 minutes (l'obfuscation prend ~30s sur sit-multi.js qui est gros).

### Étape 3 : compiler l'installeur Inno

1. Ouvrir `installer\mcl-sit-installer.iss` avec **Inno Setup Compiler** (le double-clic le fait par défaut une fois Inno installé)
2. Appuyer sur **F9** (ou menu Build → Compile)
3. Attendre 1-2 minutes (compression LZMA2/ultra)
4. Quand c'est fini, le fichier `MCL-SIT-Setup-18.0.0.exe` est dans `installer\output\`

### Étape 4 : tester l'installeur

1. Récupérer `installer\output\MCL-SIT-Setup-18.0.0.exe`
2. Le copier sur **un PC vierge** (sans Node, sans rien — ou une VM Windows propre)
3. Double-clic → suivre le wizard :
   - Choisir le dossier d'install
   - Choisir le dossier DCS Saved Games (le hook y sera copié)
   - Cocher/décocher l'ajout au pare-feu
   - Installer
4. Vérifier que :
   - L'app se lance après l'install (case « Lancer MCL-SIT »)
   - L'écran splash propose Client / Server / Both
   - Le menu Démarrer contient « MCL-SIT »
   - Le bureau a un raccourci (si tu as coché)
   - Le dossier `Saved Games\DCS<...>\Scripts\Hooks\` contient `SIT_WorldHook.lua`
   - Le pare-feu Windows a une règle « MCL-SIT SIT » (vérifier dans `wf.msc`)
5. Tester la désinstallation depuis Panneau de configuration → Applications

## Diagnostiquer un build raté

### `npm run build:installer` échoue avec « FATAL: ... does not exist »
- C'est que electron-builder a planté avant. Lance d'abord juste `npm run build:portable` et lis les erreurs.

### Inno se plaint « Source file not found »
- Tu as oublié de lancer `npm run build:installer` avant Inno.
- Ou bien tu as supprimé `dist\win-unpacked\`.

### L'installeur compile mais .exe lance puis se ferme aussitôt
- Probable problème de chemin dans `main.js` (asar inclus / non).
- Tester d'abord `npm start` (lancement dev) — si ça marche pas non plus, c'est un bug de code, pas de package.
- Sinon tester `dist\win-unpacked\MCL-SIT.exe` directement — si ça plante là aussi, c'est un problème electron-builder.

### Pare-feu pas configuré
- Vérifier qu'Inno a été lancé en admin (UAC accepté pendant l'install).
- Sinon, ouvrir un PowerShell admin et taper :
  ```
  netsh advfirewall firewall add rule name="MCL-SIT SIT (TCP 5026)" dir=in action=allow protocol=TCP localport=5026
  netsh advfirewall firewall add rule name="MCL-SIT SIT (UDP 5026)" dir=in action=allow protocol=UDP localport=5026
  ```

## Structure des fichiers générés

Après un build complet :

```
mcl-sit/
├── dist/
│   └── win-unpacked/                              ← portable Electron (créé par npm)
│       ├── MCL-SIT.exe
│       ├── resources/
│       │   ├── app.asar                           ← ton code obfusqué (Lot 4)
│       │   └── lua/SIT_WorldHook.lua              ← hook embarqué pour copy à l'install
│       ├── locales/
│       └── ... (200 fichiers Electron)
└── installer/
    ├── mcl-sit-installer.iss                      ← script Inno
    └── output/
        └── MCL-SIT-Setup-18.0.0.exe       ← LIVRABLE FINAL
```

C'est uniquement ce dernier `.exe` que tu distribues. Tout le reste reste sur ton PC dev.

## À retenir

- **`npm run build:installer`** → prépare `dist/win-unpacked/`
- **Inno + F9** → produit le `.exe` final dans `installer/output/`
- L'utilisateur final télécharge **uniquement** le `.exe` final (~80 MB)
- Il n'a besoin de **rien d'autre** installé sur sa machine
- Tu peux distribuer ce .exe par mail, Discord, GitHub Releases, peu importe
