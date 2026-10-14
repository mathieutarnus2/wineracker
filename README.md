# Ma cave à vin — version indépendante

L'application de gestion de cave, avec ses propres comptes (e-mail, Google, Apple), hébergée sur Firebase.

- `src/app.html` : l'application (plan de la cave, inventaire, scan, sorties, réglages).
- `src/shell.html` : la page d'accueil et l'écran de connexion.
- `src/firebase.js` : le lien entre l'application et Firebase (comptes, base de données, appels à Claude, sauvegarde).
- `functions/` : les fonctions serveur. La clé Anthropic y reste : elle n'arrive jamais dans le navigateur.
- `firestore.rules` : chaque utilisateur ne voit que ses propres données.
- `public/` : ce qui est mis en ligne (`index.html` et `js/firebase.js` sont générés par `npm run build`).
- `public/reglages.json` : les boutons de connexion affichés (Google, Apple).

## Ce qu'il faut avant de commencer

| Compte | Coût | À quoi il sert |
|---|---|---|
| Compte Google + projet Firebase | Gratuit, puis formule **Blaze** (paiement à l'usage, carte bancaire) | Hébergement, comptes, base de données, fonctions |
| Clé API Anthropic ([console.anthropic.com](https://console.anthropic.com)) | À l'usage | Scan d'étiquettes, conseils, estimations de prix, analyse des photos de cave |
| GitHub | Gratuit | Garder le code et son historique |
| Apple Developer (facultatif) | 99 $/an | Bouton « Continuer avec Apple » |

Sur un ordinateur : [Node.js 22](https://nodejs.org) et l'outil Firebase (`npm install -g firebase-tools`).

## Mise en ligne, étape par étape

1. **Créer le projet** sur [console.firebase.google.com](https://console.firebase.google.com) (Google Analytics n'est pas nécessaire). Notez son identifiant, puis remplacez `ma-cave-a-vin` dans `.firebaserc`.
2. **Passer en formule Blaze** (menu « Mise à niveau »). Elle est nécessaire pour les fonctions serveur. Définissez tout de suite une **alerte budget** (par exemple 10 €/mois) dans la console Google Cloud, rubrique Facturation.
3. **Base de données** : Firestore Database, « Créer une base », mode production, emplacement **europe-west9 (Paris)** ou **eur3 (Europe)**. Cet emplacement ne peut plus être changé ensuite.
4. **Comptes** : Authentication, « Commencer », puis activez :
   - **E-mail/Mot de passe** ;
   - **Google** (choisissez l'adresse de contact) ;
   - **Apple** plus tard, voir plus bas.
   Dans Authentication, Modèles, passez la langue des e-mails en français.
5. **Enregistrer la clé Anthropic** comme secret, depuis le dossier du projet :
   ```
   firebase login
   firebase functions:secrets:set ANTHROPIC_API_KEY
   ```
6. **Installer et publier** :
   ```
   npm install
   cd functions && npm install && cd ..
   npm run deploy
   ```
   L'application est alors en ligne sur `https://<identifiant>.web.app`.
7. **Créer votre compte** sur l'application, puis Réglages, Sauvegarde, **Importer une sauvegarde** avec le fichier `sauvegarde-ma-cave.json` fourni à part (vos 63 vins et leurs photos).
8. **Sur iPhone** : ouvrez l'adresse dans Safari, Partager, « Sur l'écran d'accueil ».

### Votre nom de domaine

Hosting, « Ajouter un domaine personnalisé », puis suivez les indications DNS. Ajoutez ensuite ce domaine dans Authentication, Paramètres, **Domaines autorisés**.

Pour que la connexion Google et Apple fonctionne depuis l'icône de l'écran d'accueil sur iPhone, la connexion doit se faire sur votre propre domaine :

1. Mettez `"authSurLeDomaine": true` dans `public/reglages.json`.
2. Dans la console Google Cloud, Identifiants, client OAuth « Web client (auto created by Google Service) », ajoutez l'URI de redirection `https://<votre-domaine>/__/auth/handler`.
3. Republiez avec `npm run deploy`.

### Se connecter avec Apple

1. Inscription à l'Apple Developer Program.
2. Sur developer.apple.com, créez un **Services ID** (par exemple `com.votredomaine.cave.web`). Activez « Sign in with Apple », avec le domaine de l'app et l'URL de retour `https://<identifiant>.firebaseapp.com/__/auth/handler` (ou celle de votre domaine).
3. Créez une **clé** « Sign in with Apple » et téléchargez le fichier `.p8`.
4. Dans Firebase, Authentication, Apple : saisissez le Services ID, l'identifiant d'équipe, l'identifiant de clé et le contenu du `.p8`.
5. Mettez `"apple": true` dans `public/reglages.json`, puis `npm run deploy`.

## Réglages côté serveur

Ils se modifient dans `functions/.env` (créez le fichier), puis `firebase deploy --only functions` :

```
CLAUDE_MODEL=claude-sonnet-5-5
QUOTA_JOUR=150
```

- `CLAUDE_MODEL` : le modèle utilisé pour le scan et les estimations.
- `QUOTA_JOUR` : le nombre d'appels à Claude par utilisateur et par jour. Il protège votre facture.

## Langues

L'application existe en français, anglais, allemand, italien et espagnol.

- La langue est choisie automatiquement d'après celle du téléphone ou du navigateur (anglais si elle n'est pas proposée), puis peut être changée dans Réglages, « Compte et sécurité ». Le choix est gardé sur l'appareil et dans le profil de l'utilisateur.
- Les textes sont écrits en français dans le code. Les traductions sont dans `public/i18n/en.json`, `de.json`, `it.json` et `es.json` : chaque ligne associe le texte français exact à sa traduction. `{n}`, `{vin}`… sont remplacés par des valeurs ; « singulier|pluriel » donne les deux formes.
- Un texte français absent d'un dictionnaire s'affiche simplement en français.
- Les conseils, estimations et analyses rédigés par Claude sont demandés dans la langue de l'utilisateur.

## Back-office

`https://<site de l'app>/admin` : liste des comptes, formules, bouteilles, usage de Claude ; offrir une formule (pour une durée ou sans limite), relever le nombre d'appels à Claude par jour, suspendre un compte, créer un lien de mot de passe, exporter en CSV.

- Accès réservé aux e-mails du paramètre `ADMINS` des fonctions (demandé au premier déploiement, gardé dans `functions/.env.<projet>`), avec un e-mail vérifié (la connexion Google le garantit).
- Les accès offerts sont rangés dans `offres/{uid}` (lisibles seulement par le serveur). Une formule offerte plus grande que celle payée passe devant ; l'abonnement Stripe n'est pas touché.

## Page d'accueil (wineracker.com)

Pour l'instant, `landing/index.html` est une **page d'attente** (logo, liste d'attente par e-mail via la fonction `listeAttente`, rangée dans `attente/`, exportable depuis le back-office). Le site complet est dans `landing-src/accueil.html` ; il est publié chiffré (`landing/accueil.enc.json`) et ne s'ouvre qu'avec le mot de passe, saisi via « Se connecter via mot de passe ». Après une modification du site complet : `VITRINE_MDP='…' node scripts/chiffrer-vitrine.mjs`. Le jour du lancement, remplacez `landing/index.html` par `landing-src/accueil.html`.

Le dossier `landing/` est publié sur un second site Firebase Hosting (cible `vitrine`, site `wineracker-com`), l'app reste sur la cible `app`. Les deux partent avec `firebase deploy --only hosting`. Les textes sont en français dans la page, les autres langues dans le script en bas de `landing/index.html`.

## Développement local

Avec Java installé, `npm run emulateurs` lance l'application sur `http://localhost:5000`, avec des comptes et une base de test : rien ne touche à la production.

## Données et vie privée

- Toutes les données d'un utilisateur sont rangées sous `users/{uid}/` et protégées par `firestore.rules`.
- Réglages, Sauvegarde : l'utilisateur peut exporter toutes ses données dans un fichier, et les réimporter.
- Réglages, Compte : il peut supprimer son compte et toutes ses données (fonction `supprimerCompte`).
- Les photos d'étiquettes et de cave envoyées pour analyse passent par Anthropic.

Avant une ouverture au public, il faudra ajouter des **mentions légales**, une **politique de confidentialité** et des **conditions d'utilisation**, avec l'avis d'un juriste.

## Ce qui reste à faire avant un lancement public

- Pages légales (voir ci-dessus) et lien vers elles depuis l'écran de connexion.
- Abonnement : la limite de 50 bouteilles en gratuit, puis le paiement (Stripe sur le web ; achats intégrés si l'app passe par l'App Store).
- Application iOS et Android sur les stores, en emballant ce site web (par exemple avec Capacitor).
- Sauvegarde automatique de la base Firestore (exports planifiés).

## Abonnement (Stripe)

- 50 bouteilles gratuites, puis trois formules annuelles : Cave 100 (5,99 €), Cave 200 (9,90 €), Grande cave (19,90 €, illimitée). Les formules sont dans `functions-paiement/plans.js` (et leur affichage dans `src/firebase.js`).
- Les fonctions Stripe sont dans `functions-paiement/` (codebase « paiement »), publiées à part : `npm run deploy:paiement`.
- L'état d'un abonnement n'est écrit que par le serveur, dans `abonnements/{uid}`, après confirmation de Stripe (webhook). L'application le lit via la fonction `etatAbonnement`.
- `COMPTES_OFFERTS` (paramètre des fonctions) : e-mails qui ont la version complète sans payer.
- Tant que `"paiement": false` dans `public/reglages.json`, aucune limite n'est appliquée.

Mise en route : voir les étapes données dans la conversation (compte Stripe, clés en secrets, webhook, puis `"paiement": true`).

## Dépannage (projet rattaché à une organisation Google Workspace)

Les règles de sécurité par défaut de l'organisation ont demandé, une fois pour toutes :

- d'autoriser l'accès public aux fonctions pour ce projet (règle `iam.allowedPolicyMemberDomains` : `allowAll`) ;
- de donner au compte de service `229981076704-compute@developer.gserviceaccount.com` les rôles `roles/cloudbuild.builds.builder`, `roles/datastore.user` et `roles/firebaseauth.admin`.

Pour lire l'erreur d'une fonction : `gcloud functions logs read <nom> --region europe-west1 --project wineracker-2e52e --limit 20`.

Stripe : le compte utilise « Managed Payments » (Stripe gère la TVA) ; les produits portent le code fiscal `txcd_10103000` (logiciel en ligne, usage personnel).
