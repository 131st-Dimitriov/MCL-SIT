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


