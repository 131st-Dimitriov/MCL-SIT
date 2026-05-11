# MCL-SIT

Système d'information tactique pour **DCS World**, conçu pour les équipages au sol et les opérations interarmes.

![Aperçu MCL-SIT](docs/screenshot.png)

---

## C'est quoi ?

MCL-SIT est une **tablette tactique** qui tourne en parallèle de DCS et donne à l'équipage une vision claire de la situation : positions amies et ennemies, plans de feu, gestion de l'EVASAN, communication entre joueurs, le tout sur une carte topographique avec grille MGRS.

L'idée : sortir le commandement de la tête du chef de char et lui donner un vrai outil pour planifier, coordonner et rendre compte. Comme dans la vraie vie.

## Ce que ça permet

- **Situation tactique partagée** entre tous les véhicules connectés (joueurs et IA)
- **Plans de feu artillerie** (JFO) avec sélection de la pièce, type de tir, ajustement
- **Spawn de groupes** en cours de mission : peloton 105, CSAR, ravitaillement
- **EVASAN** : demande, prise en charge, suivi des blessés
- **Profil d'élévation** entre deux points (visée masquée, ligne de vue)
- **DDM** — détection missile partagée à toute la coalition
- **Drone** : plan de vol partagé, retasking en clic droit
- **Chat tactique** (texte + messages prédéfinis)
- **PCDB** — notes partagées géolocalisées sur la carte
- **Coordination CSAR** avec recherche de pilote éjecté

## Comment ça marche

- Un **serveur SIT** tourne sur la machine DCS (ou un PC dédié)
- Chaque joueur lance MCL-SIT en mode **Client** et se connecte au serveur
- Un **hook Lua** côté DCS fait remonter la position des véhicules, les ennemis détectés, les événements de mission
- Tout est synchronisé en temps réel via WebSocket

Pour les sessions solo : un mode **Client + Serveur** permet de tout faire tourner sur le même PC.

## Installation

Télécharge le dernier [installeur dans la section Releases](../../releases/latest) (`MCL-SIT-Setup-X.Y.Z.exe`), exécute, suis le wizard. Tout est inclus : Node.js embarqué, hook DCS posé automatiquement, pare-feu configuré.

Les mises à jour sont vérifiées au démarrage de l'app.

---

*Développé par 131st-Dimitriov pour la 131st Squadron.*
