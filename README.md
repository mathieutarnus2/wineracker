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
