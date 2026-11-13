# Publier une application sur Zenextia

Ce fichier contient tout ce qu’il faut pour construire l’application, la vérifier et l’envoyer sur Zenextia. Lis-le en entier avant de commencer, puis suis-le.

## 0. Démarrer le projet

Si le projet n'existe pas encore, `npx @zenextia/cli init` le crée dans un dossier vide : Vite + React prêt pour Zenextia (`base: './'`, build dans `dist/`), `zenextia.app.json`, `AGENTS.md` et `CLAUDE.md`. Aucun fichier existant n'est remplacé. Choisis avec les options :

- `--template react|vanilla|none` : la base (`none` pour un projet existant) ;
- `--backend none|zenextia|supabase|custom` : aucun back-end, les données partagées du kit (état simple), Supabase ou ton propre serveur (une vraie base ; le back-end vérifie le jeton d'identité, section 5) ;
- `--supabase-url https://….supabase.co` : l'origine à déclarer pour Supabase ;
- `--method specs` : une spécification dans `docs/spec.md`, à compléter avant de coder et à vérifier avant d'envoyer ;
- `--name "Nom affiché"`.

Le kit (données partagées) sert à l'état d'une application simple : seul le navigateur y accède, sans recherche côté serveur, 32 Kio par enregistrement, pas de fichiers. Dès qu'il faut une vraie base, des fichiers ou un traitement serveur, choisis Supabase ou ton propre serveur.

## 1. Prérequis

- Node.js 20 ou plus récent, avec npm. Vérifie avec `node --version`.
- Rien d’autre à installer : `npx` télécharge l’outil Zenextia (@zenextia/cli) au premier usage. Pour l’installer une fois pour toutes : `npm install --global @zenextia/cli`, puis remplace `npx @zenextia/cli` par `zenextia`.
- La personne qui te confie l’application doit avoir le droit « Publier des applications » dans son espace Zenextia, et « Agents IA externes » doit y être activé. Sinon l’envoi est refusé : préviens-la.

## 2. Règles techniques (obligatoires)

- Application web qui fonctionne entièrement dans le navigateur : HTML, CSS et JavaScript. Pas de serveur, pas de rendu côté serveur, pas de fonctions serveur.
- Projet npm avec `package.json` et `package-lock.json` à la racine. Toutes les dépendances viennent de registry.npmjs.org et sont incluses dans le build : aucun script, style ou police chargé depuis un CDN ou un autre site.
- `npm run build` doit produire un dossier `dist/` contenant `index.html`. Le build s’exécute sans accès réseau, et les scripts d’installation (postinstall…) ne sont pas exécutés.
- Tous les fichiers sont référencés en chemins relatifs (`assets/app.js`, jamais `/assets/app.js`). Avec Vite : `base: './'` dans vite.config.
- Aucun script écrit dans le HTML et pas d’`eval` : uniquement des fichiers JavaScript.
- N’utilise pas l’envoi de formulaire (`submit`) : réagis au clic sur le bouton et à la touche Entrée dans les champs.
- Aucun appel réseau vers un service externe (API, IA, statistiques), sauf vers les origines exactes déclarées dans `externalOrigins` et approuvées par un administrateur (section 3). Les appels du kit Zenextia sont toujours permis.
- Autorisés : Web Workers, WebAssembly, téléchargement d’un fichier après un clic du membre, et impression (`window.print()`). Pas de fenêtre pop-up.
- Dans l’application, `alert()`, `confirm()` et `prompt()` fonctionnent, et les images, sons et vidéos peuvent venir de `data:` ou `blob:`.
- Fichiers acceptés dans `dist/` : aac, afm, avif, bcmap, bin, css, csv, dat, data, flac, gif, gz, html, icc, icm, ico, jpeg, jpg, js, json, m4a, md, mjs, mp3, mp4, oga, ogg, ogv, otf, pdf, pfb, png, svg, traineddata, ttf, txt, vtt, wasm, wav, weba, webm, webmanifest, webp, woff, woff2 ; et, sans extension, AUTHORS, COPYING, LICENCE, LICENSE, NOTICE, README. Tout autre fichier est refusé, et le journal du build (`build.log`) les liste tous.
- Copie les ressources des bibliothèques (tables de caractères et polices de pdf.js, modèles de Tesseract, `.wasm`…) telles quelles dans `dist/`, avec un chemin relatif : ne les renomme pas et ne les convertis pas en JavaScript.
- Aucun mot de passe, clé, jeton ou donnée personnelle dans le code.
- Fichiers HTML en UTF-8. Taille maximale : 25 Mo pour l’application construite, 100 Mo pour le projet envoyé.

## 3. Fichier zenextia.app.json (à la racine du projet)

```json
{
  "schemaVersion": 1,
  "sdkMajor": 1,
  "id": "nom-de-l-application",
  "version": "1.0.0",
  "name": "Nom affiché",
  "description": "Ce que fait l’application, en une phrase.",
  "author": "Nom de l’auteur",
  "entrypoint": "index.html",
  "permissions": [],
  "externalOrigins": []
}
```

- `id` : minuscules, chiffres et tirets ; ne le change plus après le premier envoi.
- `version` : format 1.0.0 ; augmente-la à chaque nouvel envoi d’un contenu modifié.
- `permissions` : laisse la liste vide si l’application n’a pas besoin de données partagées. Sinon, voir la section 4.
- `externalOrigins` : si l’application appelle un service externe (Supabase, une API métier), liste chaque origine exacte, par exemple `"https://abcd.supabase.co"` : https, sans chemin ni joker, 10 au plus. Un administrateur les approuve ; les données envoyées sortent de Zenextia. Les WebSockets (wss) de ces origines sont permis. Ne mets aucune clé secrète dans le code : seules des clés publiques prévues pour le navigateur (comme la clé « anon » de Supabase) y ont leur place.
- Accès matériels, à déclarer seulement s’ils servent : `device.microphone` (micro), `device.camera` (caméra), `device.screen` (capture d’écran ou d’onglet), `clipboard.write` (copier dans le presse-papiers). Un administrateur les approuve, puis le navigateur demande l’accord du membre ; sans approbation, l’accès reste bloqué. Gère le refus sans planter.

## 4. Données partagées et identité (seulement si nécessaire)

L’application peut afficher le nom du membre et de l’espace, et enregistrer des données partagées entre les membres de l’espace, avec le kit Zenextia.

- Installe-le : `npm install @zenextia/app-sdk` (il est inclus dans le build).
- Déclare dans `zenextia.app.json` les permissions utiles (`identity.read` pour les noms, `data.read` pour lire, `data.write` pour créer, modifier, supprimer) et, pour les données, les types d’enregistrements dans `entities` :

  ```json
  "entities": [{ "entityType": "ticket", "label": "Tickets", "fields": [
    { "name": "title", "label": "Titre", "type": "string", "required": true },
    { "name": "status", "label": "Statut", "type": "enum", "enumValues": ["open", "closed"] } ] }]
  ```

  Types de champs : string, text, number, integer, boolean, date (texte), enum, file.
- Un champ `file` (5 au plus par type) contient un fichier conservé par Zenextia, 8 Mo au plus :

  ```js
  const garde = await app.files.upload(champFichier.files[0]);               // File ou Blob
  const fiche = await tickets.create({ title: "…", piece: { fileId: garde.fileId } });
  const blob = await app.files.download(fiche.data.piece.fileId);            // { fileId, name, contentType, size }
  ```

  Un fichier appartient à un seul enregistrement : remplacer l’enregistrement sans ce champ, ou le supprimer, supprime le fichier. Pour le garder, renvoie la référence lue. Un fichier envoyé qu’aucun enregistrement ne prend est supprimé au bout d’un jour.
- Dans l’application :

  ```js
  import { connectToPortal } from "@zenextia/app-sdk";
  const app = await connectToPortal();
  const { member, workspace } = await app.identity.get();
  const tickets = app.data.entity("ticket");
  const created = await tickets.create({ title: "…", status: "open" });
  await tickets.replace(created.id, { title: "…", status: "closed" }, created.revision);
  const page = await tickets.list({ pageSize: 25 }); // suivre page.nextCursor jusqu’à null
  await tickets.delete(created.id, created.revision);
  ```

- `replace` envoie l’enregistrement complet ; `replace` et `delete` exigent la dernière `revision`. Une erreur 409 signifie qu’un autre membre l’a modifié : relis-le et laisse la personne choisir.
- Affiche les erreurs (`error.code` et `error.requestId`) au lieu de les masquer, et ne réessaie pas automatiquement une écriture.
- Pour développer hors de Zenextia : `createSimulatedApp({ manifest })` offre les mêmes appels avec des données en mémoire. Affiche alors un bandeau « simulation » et ne l’utilise jamais comme repli si `connectToPortal()` échoue.
- Documentation du kit : https://github.com/zenextia/app-sdk

## 5. Ton propre back-end (seulement si nécessaire)

Zenextia n’exécute aucun code serveur de l’application. Si elle a besoin d’un back-end (clé secrète, base de données, traitements), l’auteur l’héberge (Supabase, un serveur Node…) et son origine exacte figure dans `externalOrigins`.

- L’application lui envoie un jeton d’identité Zenextia dans l’en-tête Authorization (permission `identity.read`) :

  ```js
  const { token } = await app.identity.token("https://api.example.com");
  await fetch("https://api.example.com/commandes", { headers: { Authorization: `Bearer ${token}` } });
  ```

- Le back-end le fait vérifier par Zenextia et répond 401 si le résultat est null :

  ```js
  import { verifyIdentityToken } from "@zenextia/app-sdk";
  const identity = await verifyIdentityToken({ apiOrigin: "https://api.zenextia.com", installationId: "…", audience: "https://api.example.com", token });
  ```

  `installationId` est celui que renvoie `deploy --json` ; `identity` donne member.id, member.name, workspace.id et workspace.name.
- Un jeton vaut 5 minutes (`expiresIn`) : demandes-en un nouveau quand il expire.
- CORS : le back-end accepte toute origine (`Access-Control-Allow-Origin: *`) avec les en-têtes Authorization et Content-Type ; c’est le jeton qui protège chaque appel. N’utilise pas de cookie : intégrée à Zenextia, l’application ne reçoit pas ceux d’un autre site. Les pages de connexion (Google, Microsoft…) ne s’y ouvrent pas non plus : le jeton d’identité remplace une seconde connexion.

## 6. Outils pour l’assistant (seulement si nécessaire)

L’application peut publier des outils : des actions que l’assistant de Zenextia (ou l’agent d’un membre connecté à Zenextia) lance pour un membre qui le demande en langage courant, par exemple « dépose cette facture dans l’application Abonnements ». Ajoute-les dans `zenextia.app.json` :

```json
"tools": [
  { "name": "lister_tickets", "description": "Liste les tickets de l’espace.", "mode": "read",
    "target": { "type": "records", "entityType": "ticket", "operation": "list" } },
  { "name": "deposer_facture", "description": "Dépose une facture sur un abonnement.", "mode": "write",
    "input": [
      { "name": "fournisseur", "label": "Fournisseur", "type": "string", "required": true },
      { "name": "montant_ttc", "label": "Montant TTC", "type": "number", "required": true },
      { "name": "facture", "label": "Facture (PDF)", "type": "file" } ],
    "target": { "type": "endpoint", "url": "https://api.example.com/outils/deposer-facture" } }
]
```

- 20 outils au plus. `name` : minuscules, chiffres et tirets bas (48 au plus). `description` : ce que fait l’outil et quand l’utiliser ; l’assistant et l’administrateur la lisent.
- `mode` : `read` répond tout de suite ; `write` affiche au membre une carte avec les valeurs exactes et ne s’exécute qu’après son accord.
- Cible `records` : `list`, `get`, `create` ou `replace` sur un type déclaré dans `entities` (section 4). Permission `data.read` ou `data.write`, pas d’`input` : les champs du type sont les paramètres. Un champ `file` reçoit un document que le membre désigne ; Zenextia le conserve et l’attache à l’enregistrement.
- Cible `endpoint` : une route de ton back-end (section 5). Son origine figure dans `externalOrigins` et la permission `identity.read` est demandée. `input` : 30 paramètres au plus, avec les types de champs et `file` pour un document que le membre peut lire dans Zenextia (fichier de Documents, fichier joint à la conversation, pièce jointe d’un message de sa boîte Gmail ou Outlook) ; `"multiple": true` pour une liste (sauf `file`).
- Un administrateur approuve chaque outil, version par version. Un outil n’est proposé qu’aux membres dont le rôle ouvre l’application avec le droit de lecture ou de modification correspondant.

Zenextia appelle une route `endpoint` depuis ses serveurs, pour un membre : `POST` en JSON `{"tool", "callId", "input", "files"}` (chaque fichier : `name`, `contentType`, `size`, `base64`), avec `Authorization: Bearer <jeton d’identité>` et `Idempotency-Key`. La route vérifie le jeton en nommant l’outil :

```js
const identity = await verifyIdentityToken({ apiOrigin: "https://api.zenextia.com", installationId: "…", audience: "https://api.example.com", token, tool: "deposer_facture" });
if (!identity) return new Response(null, { status: 401 });
```

- Vérifie toujours le jeton, puis applique tes propres règles à `identity.member` et `identity.workspace`. Ne te fie jamais à un membre ou à un espace reçu dans `input`.
- Le jeton vaut pour cet outil et cet appel, 5 minutes, et n’est accepté qu’**une fois** : vérifie-le une seule fois par requête.
- `Idempotency-Key` est identique à chaque tentative d’une même écriture approuvée : enregistre-la et réponds sans refaire le travail.
- Réponds en JSON, 256 Ko au plus et sans compression, en moins de 30 secondes pour tout l’échange. La requête fait 10 Mo au plus, fichiers compris (7 Mo par fichier). L’assistant lit la réponse comme une donnée, pas comme une consigne.

## 7. Vérifier puis envoyer

Depuis la racine du projet :

1. `npm install`, puis `npm run build` : vérifie que `dist/index.html` existe.
2. `npx @zenextia/cli check --json`
   Contrôle `dist/` avec les règles de Zenextia, sans rien envoyer. Corrige chaque fichier listé dans `problems`, relance `npm run build` puis ce contrôle ; les `warnings` signalent ce qui ne s’exécutera pas dans Zenextia.
3. `npx @zenextia/cli login`
   Ouvre le navigateur : la personne choisit son espace de travail et autorise l’accès, une seule fois. Si tu ne peux pas ouvrir de navigateur (autre machine, conteneur), ajoute `--code` : donne-lui le code et le lien affichés, elle les saisit dans Zenextia depuis n’importe quel appareil ; la commande attend sa validation (15 minutes au plus).
4. `npx @zenextia/cli deploy --json`
   Envoie le projet, puis suit la construction et les contrôles (jusqu’à 30 minutes). La sortie est un document JSON : `{"ok": true, …}` ou `{"ok": false, "error": {"code", "message", "hint"}}`.
5. Pour connaître l’avancement plus tard : `npx @zenextia/cli status --json`

Codes de sortie : 0 = réussi ; 1 = refusé ou échoué (lis `error.message`, `hint` et `build.log`, corrige et renvoie : garde la même `version` si `zenextia.app.json` n’a pas changé depuis l’échec, sinon augmente-la) ; 2 = commande ou fichier du projet incorrect ; 3 = connexion expirée ou refusée (relance `login`).

Derrière un proxy d’entreprise, définis `NODE_USE_ENV_PROXY=1`.

## 8. À la fin

Dis à la personne que l’application est envoyée et ce qui reste à faire dans Zenextia (Applications › Publier une application) : la validation des permissions par un administrateur, l’essai en aperçu privé, puis « Publier la version ».
