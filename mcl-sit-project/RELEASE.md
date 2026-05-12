# MCL-SIT — Publier une nouvelle version

Ce guide te montre comment publier une mise à jour qui sera **automatiquement détectée** par tous les utilisateurs au prochain lancement de leur app.

## Pré-requis

- Compte GitHub `131st-Dimitriov` configuré
- Repo `131st-Dimitriov/MCL-SIT` créé et accessible
- Git installé localement, ton code source pushé
- Inno Setup installé
- Node.js et npm installés
- (Optionnel) Variable d'environnement `GH_TOKEN` configurée (utile pour push automatique des releases — pas indispensable car tu peux uploader manuellement)

## Étape 1 — Faire les modifs

Code, teste, valide ton truc. Quand t'es prêt à publier :

## Étape 2 — Bumper la version

Édite `package.json`, change la ligne :
```json
"version": "16.0.0"
```
vers la nouvelle, exemple `"16.0.1"` ou `"16.1.0"`.

Édite aussi **`installer/mcl-sit-installer.iss`**, ligne :
```
#define AppVersion "16.0.0"
```
Mets la même version.

## Étape 3 — Builder

```
npm run build:installer
```
Puis ouvre `installer/mcl-sit-installer.iss` dans Inno Setup, F9.

Tu obtiens dans `installer/output/` :
```
MCL-SIT-Setup-16.0.1.exe
```

**Important** : le nom du fichier doit suivre exactement le pattern `MCL-SIT-Setup-X.Y.Z.exe`. Le code de l'auto-updater dans l'app cherche ce pattern dans les assets de la release GitHub. Si tu le renommes, l'auto-update ne le trouvera pas.

## Étape 4 — Commit + tag

Dans ton dossier projet :

```
git add .
git commit -m "Release v16.0.1 — description courte des changements"
git tag v16.0.1
git push --follow-tags
```

Le `--follow-tags` envoie le commit ET le tag d'un coup. GitHub voit le nouveau tag.

## Étape 5 — Créer la release sur GitHub

1. Va sur https://github.com/131st-Dimitriov/MCL-SIT/releases
2. Clique **"Draft a new release"**
3. **Choose a tag** : sélectionne le tag `v16.0.1` que tu viens de pusher
4. **Release title** : `MCL-SIT v16.0.1`
5. **Description** : tape une description des changements, par exemple :
   ```
   ## Nouveautés
   - Fix du mode Both qui plantait au démarrage
   - Amélioration de la grille MGRS

   ## Bugs corrigés
   - Le serveur ne s'arrêtait pas proprement
   ```
6. **Attach binaries** : glisse-dépose ton fichier `installer/output/MCL-SIT-Setup-16.0.1.exe` dans la zone "Attach binaries"
7. **"Set as the latest release"** : laisse coché (très important — c'est ce drapeau qui dit à l'auto-updater "voilà la dernière")
8. Clique **"Publish release"**

## Étape 6 — Vérifier

1. Va sur https://github.com/131st-Dimitriov/MCL-SIT/releases
2. Tu dois voir la release `v16.0.1` en première position, marquée "Latest"
3. Sous "Assets", tu dois voir ton `MCL-SIT-Setup-16.0.1.exe`

## Étape 7 — Tester l'auto-update côté utilisateur

1. Lance MCL-SIT sur un PC où la **version 16.0.0** est installée (ou désinstalle ta 16.0.1 et réinstalle la 16.0.0 d'avant pour simuler)
2. Au splash, tu dois voir en haut le statut "MAJ DISPO 16.0.1"
3. Une modale s'affiche immédiatement :
   ```
   MISE À JOUR DISPONIBLE
   Version actuelle : 16.0.0
   Nouvelle version : 16.0.1
   [Plus tard]  [Télécharger maintenant]
   ```
4. Clic "Télécharger" → barre de progression
5. À 100%, l'installeur se lance automatiquement, l'app se ferme
6. L'utilisateur passe par le wizard Inno habituel (DCS folders + firewall — déjà cochés par défaut s'il a déjà installé)
7. Au prochain lancement, version 16.0.1

## Diagnostic problèmes

### "MAJ INDISPONIBLE" affiché au splash
- Pas de release publiée sur GitHub
- Ou le repo est privé (doit être public pour que l'API GitHub soit accessible sans token côté client)
- Ou problème réseau

### "Aucun installeur trouvé dans la release X.Y.Z"
- Le fichier `.exe` attaché à la release ne suit pas le pattern `MCL-SIT-Setup-X.Y.Z.exe`
- Re-uploade en respectant le nom exact

### L'app dit "À JOUR 16.0.0" mais une release 16.0.1 existe
- Vérifie que la release est bien marquée "Latest" sur GitHub
- Vérifie que le tag est `v16.0.1` (avec le `v` en préfixe)
- Vérifie que le `package.json` de l'app installée a bien `"version": "16.0.0"` (pas une 16.0.1 oubliée)

### L'app télécharge mais l'installeur ne se lance pas
- Check le `app.log` dans `%APPDATA%\MCL-SIT\app.log` — il y a les détails
- Cause probable : antivirus qui bloque l'exécution depuis le dossier temp Windows
- Workaround : clique droit sur le fichier dans `%TEMP%\mclsit-upd-XXXX\`, "Exécuter en tant qu'administrateur"

### "Échec du téléchargement : HTTP 404"
- L'asset a été supprimé de la release
- Re-uploade le `.exe`
