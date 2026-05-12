# Installation pas-à-pas — Lot 1

## Pré-requis

1. **Node.js LTS** (20 ou plus récent)
   - Télécharger : https://nodejs.org/en/download/ (LTS, MSI Windows x64)
   - Installer avec les options par défaut
   - Vérifier dans un terminal (PowerShell ou cmd) :
     ```
     node --version
     npm --version
     ```
   - Tu dois voir des versions, sinon Node n'est pas dans le PATH (relancer le terminal après install)

## Récupérer le projet

1. Dézippe `mcl-sit.zip` dans un dossier de travail, par exemple `D:\dev\mcl-sit\`
2. Ouvre un terminal dans ce dossier (clic droit → Ouvrir dans le terminal, ou `cd D:\dev\mcl-sit`)

## Installer les dépendances

```
npm install
```

**Ce qui se passe :**
- Téléchargement d'Electron (~80 MB)
- Téléchargement d'electron-builder (~170 MB)
- Total ~250 MB de fichiers dans `node_modules/`
- Durée : 1 à 5 min selon la connexion

À la fin tu dois voir quelque chose comme :
```
added 250 packages, and audited 251 packages in 2m
```

**Si erreur :**
- Erreur réseau → relancer `npm install`, c'est idempotent
- Erreur de permissions → lancer le terminal en admin
- Erreur "EACCES" sur Windows avec un antivirus → ajouter une exception au dossier

## Lancer en dev

```
npm start
```

Une fenêtre Electron s'ouvre avec le SIT V15 dedans, **comme si tu ouvrais le HTML
dans Chrome mais dans une vraie application desktop**.

Pour lancer avec les DevTools ouverts (utile pour débugger) :
```
npm run start:dev
```

## Builder un .exe pour tester sans Node

```
npm run build:portable
```

Génère un `.exe` dans `dist/` (~80 MB, autonome). Tu peux le copier sur n'importe quelle
machine Windows et le double-cliquer — pas besoin de Node installé.

**À ce stade (Lot 1), ce .exe ne fait que ce que faisait ton HTML dans Chrome.
Pas encore d'installer NSIS, pas encore de hook DCS auto-installé.
On verra ça au Lot 2 puis 3.**

## Quoi tester

1. La fenêtre s'ouvre, le SIT s'affiche
2. Pas d'erreur dans la console (Ctrl+Shift+I si tu veux la voir, ou `npm run start:dev`)
3. Tu peux taper du texte dans les modales (chat, JFO, etc.) — vérifie que ça marche
4. Tu peux fermer / rouvrir / Alt+Tab sans problème
5. Le menu Fichier > Quitter ferme proprement

**Ce qui ne marche PAS encore (normal, c'est Lot 2+) :**
- Connexion au serveur `sit-multi.js` — il n'est pas encore lancé automatiquement
- Choix Client / Server / Both — pas encore d'écran de sélection
- Auto-update
- Installeur

Si tu veux tester la connexion serveur **dès maintenant**, lance manuellement dans un autre
terminal :
```
node src/server/sit-multi.js
```
Puis dans l'app Electron, clique MULTI et configure `127.0.0.1:5026` comme avant.

## Reporter un bug

Note :
- Le message d'erreur exact (console DevTools ou terminal `npm start`)
- L'action qui a déclenché
- La version de Node (`node --version`)

Et envoie-le moi.
